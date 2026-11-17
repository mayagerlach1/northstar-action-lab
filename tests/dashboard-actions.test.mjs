import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardActionsService, scopeMetrics } from "../server-lib/dashboard-actions.mjs";
const access = "synthetic-test-access-key-over-32-chars";
const requestId = "00000000-0000-4000-8000-000000000001";
const headers = `Bearer ${access}`;
const seed = { meta: { asOf: "2026-11-17" }, orders: [
  { id: "NS-1041", product: "Summit desk bundle", category: "Workspace", region: "Northeast", channel: "Online", status: "delivered", owner: "Finance operations", promisedDate: "2026-11-07", deliveredDate: "2026-11-06", revenue: 1200, cost: 1320, refund: 0 },
  { id: "NS-1042", product: "Field travel mug", category: "Everyday", region: "West", channel: "Store", status: "delivered", owner: "Retail operations", promisedDate: "2026-11-04", deliveredDate: "2026-11-04", revenue: 360, cost: 180, refund: 0 },
] };
const env = { LAB_ACCESS_KEY: access, TRELLO_API_KEY: "a".repeat(32), TRELLO_TOKEN: "b".repeat(64), TRELLO_LIST_ID: "c".repeat(24), RESEND_API_KEY: `re_${"x".repeat(32)}`, LAB_EMAIL_TO: "teacher@example.org", LAB_GITHUB_TOKEN: "test-token", LAB_GITHUB_REPOSITORY: "classroom/lab" };
const execute = (action, draft) => ({ operation: "execute", action, scope: {}, requestId, confirmed: true, draft, snapshot: { fingerprint: "0".repeat(64) } });
async function reviewed(service, input) {
  const preview = await service.submit({ ...input, operation: "preview", snapshot: undefined }, headers);
  assert.equal(preview.status, 200);
  return { ...input, snapshot: preview.body.snapshot };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const rows = () => seed.orders.map(row => ({ recordId: row.id, revenue: row.revenue, cost: row.cost, refund: row.refund, revision: 0, updatedAt: null }));

test("seed GET is explicit, revisions start at zero and unauthenticated destinations stay masked", async () => {
  const service = createDashboardActionsService({ seed, env });
  const read = await service.get();
  assert.equal(read.body.source, "seed"); assert.equal(read.body.records[0].revision, 0);
  assert.equal(read.body.authenticated, false);
  for (const value of [access, env.LAB_EMAIL_TO, env.TRELLO_TOKEN, env.LAB_GITHUB_TOKEN]) assert.equal(JSON.stringify(read.body).includes(value), false);
  assert.equal((await service.get(headers)).body.integrations.email.destination, env.LAB_EMAIL_TO);
});

test("preview uses the actual filtered records and never writes even when configuration is missing", async () => {
  let calls = 0;
  const service = createDashboardActionsService({ seed, env: {}, fetchImpl: async () => { calls++; throw new Error("Unexpected network call"); } });
  const preview = await service.submit({ operation: "preview", action: "email", scope: { search: "Summit", signal: "negative", category: "Workspace" } });
  assert.equal(preview.status, 200); assert.equal(preview.body.metrics.profit, -120);
  assert.deepEqual(preview.body.snapshot.recordIds, ["NS-1041"]); assert.equal(preview.body.recordsInScope.length, 1);
  assert.match(preview.body.defaults.body, /NS-1041/); assert.doesNotMatch(preview.body.defaults.body, /NS-1042/);
  assert.deepEqual(preview.body.missing, ["RESEND_API_KEY", "LAB_EMAIL_TO", "LAB_ACCESS_KEY"]); assert.equal(calls, 0);
});

test("invalid payload, missing configuration and invalid access key have no external effects", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Unexpected network call"); };
  const empty = createDashboardActionsService({ seed, env: {}, fetchImpl });
  assert.equal((await empty.submit({ operation: "execute", action: "arbitrary" })).status, 400);
  const input = execute("email", { to: "teacher@example.org", subject: "Reviewed subject", body: "Reviewed body" });
  const missing = await empty.submit(input); assert.equal(missing.status, 503); assert.deepEqual(missing.body.missing, ["RESEND_API_KEY", "LAB_EMAIL_TO"]);
  const service = createDashboardActionsService({ seed, env, fetchImpl });
  assert.equal((await service.submit(input, "Bearer wrong")).status, 401);
  assert.equal((await service.submit({ ...input, draft: { ...input.draft, to: "someone@example.org" } }, headers)).status, 403);
  assert.equal((await service.submit({ ...input, scope: { region: "unknown" } }, headers)).status, 400);
  assert.equal(calls, 0);
});

test("edited Trello fields reach the transport unchanged; concurrent repeats write once", async () => {
  let writes = 0, reads = 0, databaseReads = 0, release, holdReads = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const draft = { title: "My reviewed title", description: "My reviewed segment investigation" };
  const service = createDashboardActionsService({ seed, env: { ...env, LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, transports: {
    readSupabaseOrders: async () => { if (holdReads) { databaseReads++; if (databaseReads === 2) release(); await barrier; } return { state: "verified", records: rows() }; },
    createTrelloCard: async (_config, action) => { writes++; assert.equal(action.title, draft.title); assert.equal(action.body, draft.description); return { state: "created", cardId: "d".repeat(24), cardUrl: "https://trello.com/c/test" }; },
    verifyTrelloCard: async () => { reads++; return { state: "verified", matched: { title: true, body: true } }; },
  } });
  const input = await reviewed(service, execute("trello", draft));
  holdReads = true;
  const replies = await Promise.all([service.submit(input, headers), service.submit(input, headers)]);
  assert.equal(databaseReads, 2); assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(replies[0].body.state, "verified"); assert.deepEqual(replies[0].body, replies[1].body);
  assert.equal((await service.submit({ ...input, draft: { ...draft, title: "Changed" } }, headers)).status, 409);
});

test("configured database failure never silently uses stale seed values or sends", async () => {
  let sends = 0;
  const service = createDashboardActionsService({ seed, env: { ...env, LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, transports: { readSupabaseOrders: async () => ({ state: "unknown" }), createTrelloCard: async () => { sends++; } } });
  const read = await service.get(headers); assert.equal(read.status, 503); assert.deepEqual(read.body.records, []); assert.equal(read.body.source, "supabase");
  const attempt = await service.submit(execute("trello", { title: "Review", description: "Review current values" }), headers);
  assert.equal(attempt.status, 503); assert.equal(attempt.body.state, "unavailable"); assert.equal(sends, 0);
});

test("database write changes the dashboard numbers after separate read-back and conflicts on stale revision", async () => {
  let saved = rows(), writes = 0, reads = 0;
  const databaseEnv = { ...env, LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers["x-lab-access-key"], access);
    if (init.method === "GET") { reads++; return json({ state: "verified", records: saved }); }
    writes++; const change = JSON.parse(init.body); assert.equal(change.field, "cost");
    saved = saved.map(row => row.recordId === change.recordId ? { ...row, cost: change.newValue, revision: 1, updatedAt: "2026-11-17T20:00:00.000Z" } : row);
    return json({ state: "verified", record: saved[0], requestId: change.requestId, change: { field: "cost", oldValue: 1320, newValue: 1080 } });
  };
  const service = createDashboardActionsService({ seed, env: databaseEnv, fetchImpl });
  const input = await reviewed(service, { operation: "execute", action: "supabase", recordId: "NS-1041", scope: {}, change: { field: "cost", newValue: 1080, expectedValue: 1320, expectedRevision: 0, reason: "Remove the documented duplicate allocation" }, requestId, confirmed: true });
  const write = await service.submit(input, headers);
  assert.equal(write.body.state, "verified"); assert.equal(write.body.record.cost, 1080); assert.equal(write.body.record.revision, 1);
  assert.equal(writes, 1); assert.ok(reads >= 2); assert.equal(scopeMetrics([write.body.record], seed.meta.asOf).profit, 120);
  const changed = await service.submit({ ...input, requestId: "00000000-0000-4000-8000-000000000002" }, headers);
  assert.equal(changed.status, 409); assert.equal(writes, 1);
  const fresh = await service.get(); assert.equal(fresh.body.records[0].cost, 1080);
});

test("preview snapshot prevents sending changed database facts", async () => {
  let saved = rows(), writes = 0;
  const service = createDashboardActionsService({ seed, env: { ...env, LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, transports: { readSupabaseOrders: async () => ({ state: "verified", records: saved }), createTrelloCard: async () => { writes++; } } });
  const preview = await service.submit({ operation: "preview", action: "trello", scope: {} }, headers);
  saved = saved.map(row => ({ ...row, revision: 1 }));
  const attempt = await service.submit({ ...execute("trello", { title: "Reviewed", description: "Reviewed content" }), snapshot: preview.body.snapshot }, headers);
  assert.equal(attempt.status, 409); assert.equal(writes, 0);
});

test("GitHub creates an Issue and verifies exact edited content with an independent GET", async () => {
  let captured, methods = [];
  const fetchImpl = async (url, init) => {
    methods.push(init.method || "GET"); assert.match(url, /^https:\/\/api.github.com\/repos\/classroom\/lab\/issues/);
    if (init.method === "POST") { captured = JSON.parse(init.body); return json({ id: 100, number: 7, html_url: "https://github.com/classroom/lab/issues/7" }, 201); }
    return json({ id: 100, number: 7, title: captured.title, body: captured.body });
  };
  const service = createDashboardActionsService({ seed, env, fetchImpl });
  const input = await reviewed(service, { ...execute("github", { title: "Investigate cost", body: "Review the duplicate cost allocation" }), recordId: "NS-1041" });
  const reply = await service.submit(input, headers);
  assert.equal(reply.body.state, "verified"); assert.equal(reply.body.url, "https://github.com/classroom/lab/issues/7");
  assert.deepEqual(methods, ["POST", "GET"]); assert.equal(captured.title, "Investigate cost"); assert.match(captured.body, /Review the duplicate cost allocation/); assert.match(captured.body, /NS-1041/);
});

test("unknown outcomes are never automatically repeated", async () => {
  let writes = 0;
  const service = createDashboardActionsService({ seed, env, transports: { createTrelloCard: async () => { writes++; return { state: "unknown" }; } } });
  const input = await reviewed(service, execute("trello", { title: "Review", description: "Review the segment" }));
  assert.equal((await service.submit(input, headers)).body.state, "unknown");
  assert.equal((await service.submit(input, headers)).body.state, "unknown"); assert.equal(writes, 1);
});

test("execute requires a reviewed snapshot and rejects missing or stale fingerprints before effects", async () => {
  let writes = 0;
  const service = createDashboardActionsService({ seed, env, transports: { createTrelloCard: async () => { writes++; } } });
  const input = execute("trello", { title: "Review", description: "Reviewed segment" });
  const withoutSnapshot = { ...input }; delete withoutSnapshot.snapshot;
  assert.equal((await service.submit(withoutSnapshot, headers)).status, 400);
  assert.equal((await service.submit(input, headers)).status, 409);
  assert.equal(writes, 0);
});

test("new dashboard access keys require 32–256 characters and never trigger effects outside that range", async () => {
  let calls = 0;
  for (const key of ["a".repeat(31), "a".repeat(257)]) {
    const service = createDashboardActionsService({ seed, env: { ...env, LAB_ACCESS_KEY: key }, fetchImpl: async () => { calls++; } });
    const response = await service.submit(execute("trello", { title: "Review", description: "Reviewed segment" }), `Bearer ${key}`);
    assert.equal(response.status, 503); assert.match(response.body.message, /32–256/);
  }
  for (const key of ["a".repeat(32), "a".repeat(256)]) assert.equal((await createDashboardActionsService({ seed, env: { ...env, LAB_ACCESS_KEY: key } }).get(`Bearer ${key}`)).body.authenticated, true);
  assert.equal(calls, 0);
});

test("preview accepts finite sub-cent values and the Edge upper bound but rejects refund above revenue", async () => {
  const service = createDashboardActionsService({ seed, env });
  const preview = { operation: "preview", action: "supabase", recordId: "NS-1041", change: { field: "cost", newValue: 1080.12345, expectedValue: 1320, expectedRevision: 0, reason: "Documented allocation adjustment" } };
  assert.equal((await service.submit(preview, headers)).status, 200);
  assert.equal((await service.submit({ ...preview, change: { ...preview.change, newValue: 1000000000 } }, headers)).status, 200);
  assert.equal((await service.submit({ ...preview, change: { ...preview.change, newValue: 1000000001 } }, headers)).status, 400);
  assert.equal((await service.submit({ ...preview, change: { ...preview.change, field: "refund", expectedValue: 0, newValue: 1200.001 } }, headers)).status, 400);
});

test("GitHub preview uses current corrected values, segment context and source evidence for an actionable investigation", async () => {
  const contextSeed = { ...seed, orders: seed.orders.map(row => ({ ...row, note: "Synthetic audit: freight allocation of USD 240 was imported twice." })) };
  const currentRows = rows().map(row => row.recordId === "NS-1041" ? { ...row, cost: 1080, revision: 1, updatedAt: "2026-11-17T20:00:00Z" } : row);
  const service = createDashboardActionsService({ seed: contextSeed, env: { ...env, LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, transports: { readSupabaseOrders: async () => ({ state: "verified", records: currentRows }) } });
  const preview = await service.submit({ operation: "preview", action: "github", recordId: "NS-1041" }, headers);
  assert.equal(preview.status, 200);
  for (const content of ["Category: Workspace", "Region: Northeast", "Channel: Online", "Cost: USD 1080", "Revision: 1", "freight allocation of USD 240 was imported twice", "regression case", "importing the same source twice"]) assert.equal(preview.body.defaults.body.includes(content), true);
  assert.match(preview.body.defaults.title, /Prevent duplicate freight allocation/);
});

test("selected bars constrain canonical metrics and a selected record stays in scope", async () => {
  const service = createDashboardActionsService({ seed, env });
  const scope = { category: "Workspace", region: "Northeast" };
  const bar = await service.submit({ operation: "preview", action: "email", scope }, headers);
  assert.deepEqual(bar.body.snapshot.scope, scope);
  assert.deepEqual(bar.body.snapshot.recordIds, ["NS-1041"]);
  assert.deepEqual(bar.body.metrics, scopeMetrics([seed.orders[0]], seed.meta.asOf));
  assert.match(bar.body.defaults.subject, /category: Workspace · region: Northeast/);
  assert.doesNotMatch(bar.body.defaults.body, /NS-1042/);
  const outside = await service.submit({ operation: "preview", action: "trello", scope, recordId: "NS-1042" }, headers);
  assert.equal(outside.status, 400);
});

test("selected-record email and Trello drafts preserve canonical context and provenance through provider read-back", async () => {
  const contextSeed = { ...seed, orders: seed.orders.map(row => ({ ...row, note: "Synthetic audit evidence for the selected order." })) };
  const sent = {};
  const fetchImpl = async (url, init) => {
    if (url === "https://api.resend.com/emails") { sent.email = JSON.parse(init.body); return json({ id: requestId }); }
    if (url.startsWith("https://api.resend.com/emails/")) return json({ id: requestId, ...sent.email, last_event: "delivered" });
    if (url === "https://api.trello.com/1/cards") {
      sent.trello = JSON.parse(init.body);
      return json({ id: "d".repeat(24), name: sent.trello.name, desc: sent.trello.desc, idList: env.TRELLO_LIST_ID, url: "https://trello.com/c/selected1" });
    }
    if (url.startsWith("https://api.trello.com/1/cards/")) return json({ id: "d".repeat(24), name: sent.trello.name, desc: sent.trello.desc, idList: env.TRELLO_LIST_ID, url: "https://trello.com/c/selected1" });
    throw new Error("Unexpected provider endpoint");
  };
  const service = createDashboardActionsService({ seed: contextSeed, env, fetchImpl });
  for (const action of ["email", "trello"]) {
    const selection = { action, recordId: "NS-1041", scope: { region: "Northeast", search: "NS-1041" } };
    const preview = await service.submit({ ...selection, operation: "preview" }, headers);
    assert.equal(preview.status, 200);
    const draft = preview.body.defaults, body = draft.body || draft.description;
    for (const content of ["Selected record", "Record: NS-1041", "Region: Northeast", "Cost: USD 1320", "Revision: 0", "Synthetic audit evidence", "Current filtered view"]) assert.equal(body.includes(content), true);
    assert.match(draft.subject || draft.title, /NS-1041 · Summit desk bundle/);
    const reply = await service.submit({ ...selection, operation: "execute", draft, requestId, confirmed: true, snapshot: preview.body.snapshot }, headers);
    assert.equal(reply.body.state, action === "email" ? "accepted" : "verified");
    assert.equal(reply.body.verification.body, true);
  }
  for (const body of [sent.email.text, sent.trello.desc]) {
    assert.match(body, /Source record: NS-1041/); assert.match(body, new RegExp(`Action request: ${requestId}`));
    assert.doesNotMatch(body, /NS-1042/);
  }
});

test("a selected-record snapshot rejects changed facts without sending or changing the frozen scope", async () => {
  let saved = rows(), sends = 0;
  const service = createDashboardActionsService({ seed, env: { ...env, LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, transports: { readSupabaseOrders: async () => ({ state: "verified", records: saved }), createTrelloCard: async () => { sends++; } } });
  const selection = { action: "trello", scope: { region: "Northeast", search: "NS-1041" }, recordId: "NS-1041" };
  const preview = await service.submit({ ...selection, operation: "preview" }, headers);
  saved = saved.map(row => row.recordId === "NS-1041" ? { ...row, cost: 1080, revision: 1 } : row);
  const reply = await service.submit({ ...selection, operation: "execute", draft: preview.body.defaults, snapshot: preview.body.snapshot, requestId, confirmed: true }, headers);
  assert.equal(reply.status, 409); assert.equal(sends, 0);
  assert.deepEqual(reply.body.snapshot.scope, selection.scope);
  assert.deepEqual(reply.body.snapshot.recordIds, ["NS-1041"]);
});
