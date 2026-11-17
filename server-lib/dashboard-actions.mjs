import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { trelloConfigFromEnv, validateTrelloDestination, createTrelloCard, verifyTrelloCard } from "../reference/trello-card.mjs";
import { resendConfigFromEnv, validateResendDestination, createResendEmail, verifyResendEmail } from "../reference/resend-email.mjs";
import { validateDestination, createGithubIssue, githubHeaders, actionMarker } from "../reference/github-issue.mjs";
import { readSupabaseOrders, updateSupabaseOrder, validAmount } from "../reference/supabase-orders.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = ["email", "trello", "supabase", "github"];
const REQUIRED = { email: ["RESEND_API_KEY", "LAB_EMAIL_TO"], trello: ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LIST_ID"], supabase: ["LAB_SUPABASE_URL"], github: ["LAB_GITHUB_TOKEN", "LAB_GITHUB_REPOSITORY"] };
const hash = value => createHash("sha256").update(value).digest();
const isObject = value => value && typeof value === "object" && !Array.isArray(value);
const keysAllowed = (value, keys) => isObject(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, maximum, singleLine = false) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.includes("\0") && (!singleLine || !/[\r\n]/.test(value));
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const result = (status, state, message, extra = {}) => ({ status, body: { state, message, ...extra } });
const databaseUrlValid = value => typeof value === "string" && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(value);

export function orderSignals(order, asOf) {
  return [order.revenue - order.refund - order.cost < 0 && "negative", (order.deliveredDate || asOf) > order.promisedDate && "late", order.revenue > 0 && order.refund / order.revenue >= 0.25 && "refund"].filter(Boolean);
}
export function scopeMetrics(records, asOf) {
  const sum = key => money(records.reduce((total, row) => total + row[key], 0));
  const revenue = sum("revenue"), cost = sum("cost"), refund = sum("refund"), netRevenue = money(revenue - refund), profit = money(netRevenue - cost);
  return { count: records.length, revenue, cost, refund, netRevenue, profit, marginRate: netRevenue === 0 ? null : profit / netRevenue, attention: records.filter(row => orderSignals(row, asOf).length).length };
}
function filtered(records, scope, asOf) {
  return records.filter(row => {
    const signals = orderSignals(row, asOf);
    return ["category", "region", "channel", "status"].every(key => !scope[key] || row[key] === scope[key]) &&
      (!scope.search || [row.id, row.product, row.category, row.region, row.channel, row.owner].join(" ").toLowerCase().includes(scope.search.toLowerCase())) &&
      (!scope.signal || (scope.signal === "attention" ? signals.length > 0 : scope.signal === "clear" ? signals.length === 0 : signals.includes(scope.signal)));
  });
}

/** All four actions share the same filtered, authoritative dataset and server authorization. */
export function createDashboardActionsService({ env = process.env, seed, fetchImpl = fetch, timeoutMs = 12000, transports = {} } = {}) {
  const trello = trelloConfigFromEnv(env), email = resendConfigFromEnv(env);
  const [owner, repo, extra] = (env.LAB_GITHUB_REPOSITORY || "").split("/");
  const github = { owner, repo: extra ? undefined : repo, token: env.LAB_GITHUB_TOKEN };
  const supabase = { url: env.LAB_SUPABASE_URL, accessKey: env.LAB_ACCESS_KEY };
  const authorizationConfigured = typeof env.LAB_ACCESS_KEY === "string" && env.LAB_ACCESS_KEY.length >= 32 && env.LAB_ACCESS_KEY.length <= 256;
  const configured = { email: validateResendDestination(email), trello: validateTrelloDestination(trello), github: validateDestination(github), supabase: databaseUrlValid(supabase.url) };
  const transport = { createTrelloCard, verifyTrelloCard, createResendEmail, verifyResendEmail, createGithubIssue, readSupabaseOrders, updateSupabaseOrder, ...transports };
  const options = { fetchImpl, timeoutMs };
  let seedPromise;
  const getSeed = () => seedPromise ||= seed ? Promise.resolve(seed) : readFile(new URL("../public/data.json", import.meta.url), "utf8").then(JSON.parse);
  const requests = new Map(); // Warm-instance coalescing only; not a durable exactly-once ledger.
  const authorized = header => authorizationConfigured && typeof header === "string" && header.startsWith("Bearer ") && timingSafeEqual(hash(header.slice(7)), hash(env.LAB_ACCESS_KEY));
  const missingFor = action => REQUIRED[action].filter(name => typeof env[name] !== "string" || !env[name].trim());
  function destination(action, authenticated) {
    if (!authenticated) return { email: "Configured test email address", trello: "Configured Trello list", supabase: "Synthetic Supabase orders table", github: "Configured GitHub repository" }[action];
    return { email: email.to || "", trello: trello.listId ? `Trello list ${trello.listId}` : "", supabase: supabase.url ? `${supabase.url} · ie_action_lab_order_values` : "", github: owner && repo ? `${owner}/${repo}` : "" }[action];
  }
  async function current() {
    const data = await getSeed();
    const seedRecords = data.orders.map(row => ({ ...row, revision: 0, updatedAt: null }));
    if (!supabase.url) return { records: seedRecords, source: "seed", asOf: data.meta.asOf, database: { configured: false, state: "seed", message: "Using the bundled synthetic dataset. Configure LAB_SUPABASE_URL to persist changes." } };
    const unavailable = { records: [], source: "supabase", asOf: data.meta.asOf, database: { configured: true, state: "unavailable", message: "The configured database could not be read. Refresh or correct its configuration before acting; seed values are not used as a fallback." } };
    if (!configured.supabase || !authorizationConfigured) return unavailable;
    const read = await transport.readSupabaseOrders(supabase, options);
    if (read.state !== "verified" || read.records.length !== seedRecords.length || new Set(read.records.map(row => row.recordId)).size !== seedRecords.length) return unavailable;
    const values = new Map(read.records.map(row => [row.recordId, row]));
    if (seedRecords.some(row => !values.has(row.id))) return unavailable;
    const records = seedRecords.map(row => { const value = values.get(row.id); return { ...row, revenue: value.revenue, cost: value.cost, refund: value.refund, revision: value.revision, updatedAt: value.updatedAt }; });
    return { records, source: "supabase", asOf: data.meta.asOf, database: { configured: true, state: "verified", message: "Current numeric values read from Supabase." } };
  }
  async function get(header) {
    const authenticated = authorized(header), data = await current();
    return { status: data.database.state === "unavailable" ? 503 : 200, body: { ...data, authenticated, authorizationConfigured, integrations: Object.fromEntries(ACTIONS.map(action => [action, { configured: configured[action], destination: destination(action, authenticated), missing: missingFor(action) }])) } };
  }
  function validate(body, dataset) {
    if (!keysAllowed(body, ["operation", "action", "scope", "recordId", "draft", "change", "requestId", "confirmed", "snapshot"]) || !["preview", "execute"].includes(body.operation) || !ACTIONS.includes(body.action)) return "Choose a supported action and operation.";
    if (body.operation === "execute" && (body.confirmed !== true || typeof body.requestId !== "string" || !UUID.test(body.requestId))) return "Confirm the reviewed action with a valid request ID.";
    if (body.scope !== undefined && !keysAllowed(body.scope, ["category", "region", "channel", "status", "signal", "search"])) return "Unsupported filter scope.";
    const scope = body.scope || {};
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value !== "string" || value.length > (key === "search" ? 160 : 80)) return "Invalid filter value.";
      if (!value || value === "all" || key === "search") continue;
      if (key === "signal" ? !["negative", "late", "refund", "attention", "clear"].includes(value) : !dataset.orders.some(row => row[key] === value)) return "Unknown filter value.";
    }
    if (body.recordId !== undefined && (typeof body.recordId !== "string" || !dataset.orders.some(row => row.id === body.recordId))) return "Unknown source record.";
    if (["supabase", "github"].includes(body.action) && !body.recordId) return "Select a source record first.";
    const allowedDraft = { email: ["to", "subject", "body"], trello: ["title", "description"], github: ["title", "body"], supabase: [] }[body.action];
    if (body.draft !== undefined && (!keysAllowed(body.draft, allowedDraft) || Object.entries(body.draft).some(([key, value]) => !text(value, ["body", "description"].includes(key) ? 10000 : 254, !["body", "description"].includes(key))))) return "Draft fields are missing, too long or unsupported.";
    if (body.draft?.to && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(body.draft.to)) return "Enter one valid recipient email address.";
    if (body.change !== undefined) {
      const change = body.change;
      if (body.action !== "supabase" || !keysAllowed(change, ["field", "newValue", "expectedValue", "expectedRevision", "reason"]) || !["revenue", "cost", "refund"].includes(change.field) || !validAmount(change.newValue) || !validAmount(change.expectedValue) || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0 || !text(change.reason, 600) || change.reason.trim().length < 5) return "Supply a valid numeric change, the expected value and revision, and a reason of 5–600 characters.";
    }
    if (body.operation === "execute" && (body.action === "supabase" ? !body.change : !body.draft || allowedDraft.some(key => !body.draft[key]))) return "Review every draft field or the numeric change before executing.";
    if ((body.operation === "execute" || body.snapshot !== undefined) && (!isObject(body.snapshot) || !/^[a-f0-9]{64}$/.test(body.snapshot.fingerprint || ""))) return "Preview the current data first and include its snapshot fingerprint when executing.";
    return null;
  }
  function preview(body, data, authenticated) {
    const scope = Object.fromEntries(Object.entries(body.scope || {}).filter(([, value]) => value && value !== "all"));
    const recordsInScope = filtered(data.records, scope, data.asOf), metrics = scopeMetrics(recordsInScope, data.asOf);
    const record = body.recordId ? data.records.find(row => row.id === body.recordId) : undefined;
    const label = Object.entries(scope).map(([key, value]) => `${key}: ${value}`).join(" · ") || "All orders";
    const summary = `Synthetic Northstar Retail data · as of ${data.asOf}\nScope: ${label}\nOrders: ${metrics.count}\nRevenue: USD ${metrics.revenue.toFixed(2)}\nRefunds: USD ${metrics.refund.toFixed(2)}\nCosts: USD ${metrics.cost.toFixed(2)}\nContribution: USD ${metrics.profit.toFixed(2)}\nOrders needing review: ${metrics.attention}\nRecord IDs: ${recordsInScope.map(row => row.id).join(", ")}`;
    const recordSummary = record ? `Record: ${record.id} · ${record.product}\nCategory: ${record.category}\nRegion: ${record.region}\nChannel: ${record.channel}\nRevenue: USD ${record.revenue}\nCost: USD ${record.cost}\nRefund: USD ${record.refund}\nContribution: USD ${money(record.revenue - record.refund - record.cost)}\nRevision: ${record.revision}\nSynthetic source note: ${record.note || "No additional source note."}` : "";
    const investigation = record?.id === "NS-1041"
      ? "Investigate the import step that can allocate the same USD 240 freight charge twice. Trace the source identifier and mapping, propose a check that prevents duplicate allocation on re-import, and add a regression case for this order. Use the current stored values and revision above to distinguish the recorded correction from the import defect.\n\nAcceptance: identify the duplication path; define one freight allocation per source identifier; demonstrate that importing the same source twice does not double its cost."
      : "Investigate the source note and the selected record's current values. Identify the import or operational step responsible, propose a prevention check, and describe a regression case for the same condition.";
    const selectedSummary = record ? `Selected record\n${recordSummary}\n\nCurrent filtered view\n${summary}` : summary;
    const defaults = {
      email: { to: authenticated ? email.to || "" : "", subject: record ? `[Classroom] Record summary · ${record.id} · ${record.product}` : `[Classroom] Operations summary · ${label}`, body: `${selectedSummary}\n\nPlease review ${record ? "the selected record and its source evidence" : "the current operating results"} before deciding on a follow-up.` },
      trello: { title: record ? `[Classroom] Review ${record.id} · ${record.product}` : `[Classroom] Review operations · ${label}`, description: `${selectedSummary}\n\nInvestigate ${record ? "the selected record using its source note and current values" : "the selected segment"} and record the recommended next step.` },
      github: { title: record?.id === "NS-1041" ? "[Classroom] NS-1041 · Prevent duplicate freight allocation on import" : `[Classroom] Review ${record?.id || "order"} · ${record?.product || ""}`, body: `Synthetic classroom investigation.\n\n${recordSummary}\n\n${investigation}\n\nOpening this issue records an engineering follow-up; it does not update transaction values.` },
      supabase: {},
    }[body.action];
    const snapshotData = { scope, records: recordsInScope.map(row => [row.id, row.revenue, row.cost, row.refund, row.revision]), selected: record ? [record.id, record.revenue, record.cost, record.refund, record.revision] : null, source: data.source, asOf: data.asOf };
    const snapshot = { fingerprint: hash(JSON.stringify(snapshotData)).toString("hex"), recordIds: recordsInScope.map(row => row.id), scope, source: data.source, asOf: data.asOf };
    return { state: "preview", ...(record ? { record } : {}), recordsInScope, metrics, defaults: { ...defaults, ...body.draft }, destination: destination(body.action, authenticated), ...(body.change ? { change: body.change } : {}), snapshot, missing: [...missingFor(body.action), ...(!authorizationConfigured ? ["LAB_ACCESS_KEY"] : [])], metadataNote: "A source-record and request-ID footer is appended to messages for traceability." };
  }
  async function verifyIssue(action, made) {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${github.owner}/${github.repo}/issues/${made.issueNumber}`, { headers: githubHeaders(github.token), signal: AbortSignal.timeout(timeoutMs), redirect: "error", cache: "no-store" });
      if (!response.ok) return false;
      const issue = await response.json();
      const expectedBody = `${action.body.trim()}\n\n---\nSource record: \`${action.recordId}\`\nAction request: \`${action.requestId}\`\n${actionMarker(action.requestId)}`;
      return issue.id === made.issueId && issue.number === made.issueNumber && issue.title === action.title.trim() && issue.body === expectedBody && !issue.pull_request;
    } catch { return false; }
  }
  async function execute(body, view) {
    const draft = body.draft || {}, action = { requestId: body.requestId, recordId: body.recordId || `scope:${view.snapshot.fingerprint.slice(0, 20)}`, title: draft.subject || draft.title, body: draft.body || draft.description };
    if (body.action === "supabase") {
      const saved = await transport.updateSupabaseOrder(supabase, { recordId: body.recordId, ...body.change, requestId: body.requestId, confirmed: true }, options);
      if (saved.state !== "verified") return { ...saved, message: saved.state === "conflict" ? "This record changed. Refresh and review the new values." : "The database outcome is uncertain or rejected. Read the current record before another attempt." };
      const data = await current();
      if (data.database.state !== "verified") return { state: "unknown", message: "The write was acknowledged, but the updated dashboard could not be read. Refresh before another attempt." };
      return { ...saved, ...data, record: data.records.find(row => row.id === body.recordId), message: "The numeric value was saved in Supabase and independently read back. Dashboard totals now use the saved data." };
    }
    if (body.action === "trello") {
      const made = await transport.createTrelloCard(trello, action, options);
      if (made.state !== "created") return made;
      const read = await transport.verifyTrelloCard(trello, action, made.cardId, options);
      return { state: read.state === "verified" ? "verified" : "unknown", id: made.cardId, url: made.cardUrl, verification: read.matched, message: read.state === "verified" ? "Card created and its exact edited title and description read back." : "Card creation was accepted, but read-back is uncertain. Inspect the card before another send." };
    }
    if (body.action === "email") {
      const made = await transport.createResendEmail({ ...email, to: draft.to }, action, options);
      if (made.state !== "accepted") return made;
      const read = await transport.verifyResendEmail({ ...email, to: draft.to }, action, made.emailId, options);
      const failed = ["bounced", "complained", "failed", "suppressed", "canceled"].includes(read.deliveryState);
      return { state: failed ? "rejected" : "accepted", id: made.emailId, deliveryState: read.deliveryState || "unknown", inboxVerified: false, verification: read.matched, message: failed ? `The provider reports ${read.deliveryState}.` : "Email accepted by the provider. Check the actual inbox; provider acceptance is not inbox verification." };
    }
    const made = await transport.createGithubIssue(github, action, options);
    if (made.state !== "created") return { ...made, message: made.httpStatus === 403 ? "GitHub denied issue creation. The token needs Issues: Read and write on the selected repository." : "Issue creation was rejected or is uncertain. Inspect the repository before another attempt." };
    const verified = await verifyIssue(action, made);
    return { state: verified ? "verified" : "unknown", id: made.issueNumber, url: made.issueUrl, verification: { id: verified, title: verified, body: verified }, message: verified ? "GitHub issue created and exact title, body and request ID verified with a separate read." : "Issue creation was accepted, but read-back is uncertain. Inspect it before another attempt." };
  }
  async function submit(body, header) {
    const dataset = await getSeed(), invalid = validate(body, dataset);
    if (invalid) return result(400, "rejected", invalid);
    const authenticated = authorized(header);
    if (body.operation === "execute") {
      const missing = missingFor(body.action);
      if (missing.length) return result(503, "not_configured", `Missing server configuration: ${missing.join(", ")}.`, { missing });
      if (!configured[body.action]) return result(503, "not_configured", `Check server configuration: ${REQUIRED[body.action].join(", ")}.`, { configuration: REQUIRED[body.action] });
      if (!authorizationConfigured) return result(503, "not_configured", "Configure LAB_ACCESS_KEY with 32–256 characters.", { missing: ["LAB_ACCESS_KEY"] });
      if (!authenticated) return result(401, "rejected", "Enter the server LAB_ACCESS_KEY before executing an action.");
      if (body.action === "email" && body.draft.to.toLowerCase() !== email.to.toLowerCase()) return result(403, "rejected", "The testing sender can send only to LAB_EMAIL_TO, the account owner's verified address. The recipient is editable, but another address requires a verified sending domain.");
      const key = `${body.action}:${body.requestId}`, existing = requests.get(key), signature = hash(JSON.stringify(body)).toString("hex");
      if (existing) return existing.signature === signature ? { status: 200, body: await existing.run } : result(409, "conflict", "This request ID was already used with different reviewed content.");
    }
    const data = await current();
    if (data.database.state === "unavailable") return result(503, "unavailable", data.database.message, { database: data.database, source: "supabase" });
    const view = preview(body, data, authenticated);
    if (!view.recordsInScope.length) return result(400, "rejected", "The selected filters contain no records.");
    if (body.recordId && !view.recordsInScope.some(row => row.id === body.recordId)) return result(400, "rejected", "The selected record is outside the current filters.");
    if (body.change && (view.record[body.change.field] !== body.change.expectedValue || view.record.revision !== body.change.expectedRevision)) return result(409, "conflict", "The selected record changed. Refresh before reviewing a correction.", { record: view.record });
    if (body.change) {
      const changed = { ...view.record, [body.change.field]: body.change.newValue };
      if (changed.refund > changed.revenue) return result(400, "rejected", "Refund cannot exceed revenue. Review the proposed correction.");
    }
    if (body.operation === "preview") return { status: 200, body: view };
    if (body.snapshot && body.snapshot.fingerprint !== view.snapshot.fingerprint) return result(409, "conflict", "The data changed after your preview. Refresh and review the draft again.", { snapshot: view.snapshot });
    // Another request may have completed the asynchronous database read first.
    const key = `${body.action}:${body.requestId}`, signature = hash(JSON.stringify(body)).toString("hex"), existing = requests.get(key);
    if (existing) return existing.signature === signature ? { status: 200, body: await existing.run } : result(409, "conflict", "This request ID was already used with different reviewed content.");
    if (requests.size >= 100) return result(429, "rejected", "This running instance has reached its demonstration limit.");
    const run = execute(body, view).catch(() => ({ state: "unknown", message: "The result could not be established. Inspect the destination before another attempt." })).then(value => ({ ...value, action: body.action, provider: body.action, requestId: body.requestId, checkedAt: new Date().toISOString(), snapshot: view.snapshot }));
    requests.set(key, { signature, run });
    return { status: 200, body: await run };
  }
  return { get, submit };
}
