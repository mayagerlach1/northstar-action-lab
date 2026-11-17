import { createHash, timingSafeEqual } from "node:crypto";
import { trelloConfigFromEnv, validateTrelloDestination, createTrelloCard, verifyTrelloCard } from "../reference/trello-card.mjs";
import { resendConfigFromEnv, validateResendDestination, createResendEmail, verifyResendEmail } from "../reference/resend-email.mjs";
import { createGithubPrClient, POLICY_FILE } from "../reference/github-pr.mjs";
import { supabaseConfigFromEnv, readSupabaseReview, writeSupabaseReview } from "../reference/supabase-writeback.mjs";

export const RECORD = Object.freeze({ id: "NS-1041", product: "Summit desk bundle", revenue: 1200, cost: 1320, refund: 0, contribution: -120 });
const BODY = "Synthetic classroom test — no customer data.\n\nOrder: NS-1041 · Summit desk bundle\nRevenue: USD 1,200\nProduct cost: USD 1,320\nRefunds: USD 0\nContribution: USD -120 (-10%)\n\nPlease review the recorded price, introductory discount and freight allocation before recommending a correction. This is a review request, not a confirmed error.";
export const PREVIEWS = Object.freeze({
  supabase: { title: "Mark NS-1041 as reviewed", body: "Save review status 'reviewed' for the synthetic record NS-1041 in the isolated Supabase practice table. Store the request ID and review timestamp. This records that a review took place; it does not change financial amounts or prove that the anomaly is resolved." },
  trello: { title: "[Classroom test] Review negative contribution · NS-1041", body: BODY },
  email: { title: "[Classroom test] Review request · NS-1041", body: BODY },
  github: { title: "[Classroom test] Escalate synthetic losses below -100", body: "Propose a review policy for Finance operations: profit strictly below USD -100 receives high priority. NS-1041 has profit -120 and qualifies; -50 does not. A PR proposes the change for review. It does not merge it or correct transaction data. The fixture is for this test and is not yet consumed by the dashboard.", diff: `File: ${POLICY_FILE}\n-    "highPriorityBelowProfit": null\n+    "highPriorityBelowProfit": -100` },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["trello", "email", "github", "supabase"]);
const REQUIRED_ENV = Object.freeze({
  trello: ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LIST_ID"],
  email: ["RESEND_API_KEY", "LAB_EMAIL_TO"],
  github: ["LAB_GITHUB_TOKEN", "LAB_GITHUB_REPOSITORY"],
  supabase: ["LAB_SUPABASE_URL"],
});
const hasValue = (value) => typeof value === "string" && value.trim().length > 0;
const hash = (value) => createHash("sha256").update(value).digest();

function githubConfig(env) {
  const [owner, repo, extra] = (env.LAB_GITHUB_REPOSITORY || "").split("/");
  return { owner, repo: extra ? undefined : repo, token: env.LAB_GITHUB_TOKEN, baseBranch: env.LAB_GITHUB_BASE_BRANCH || "main", filePath: env.LAB_GITHUB_POLICY_PATH || POLICY_FILE };
}
function githubReady(config) {
  try { createGithubPrClient(config); return true; } catch { return false; }
}

/** The access phrase belongs to this small single-owner test panel, not a multi-user auth system. */
export function createPreflightService({ env = process.env, transports = {} } = {}) {
  const trello = trelloConfigFromEnv(env);
  const email = resendConfigFromEnv(env);
  const github = githubConfig(env);
  const supabase = supabaseConfigFromEnv(env);
  const authorizationConfigured = typeof env.LAB_ACCESS_KEY === "string" && env.LAB_ACCESS_KEY.length >= 24;
  // Actions are always available to try. Configuration and authorization are checked per request.
  const enabled = true;
  // This only coalesces requests in one running instance. It is not a durable ledger.
  const requests = new Map();
  const functions = { createTrelloCard, verifyTrelloCard, createResendEmail, verifyResendEmail, createGithubPrClient, readSupabaseReview, writeSupabaseReview, ...transports };
  const configured = {
    trello: validateTrelloDestination(trello), email: validateResendDestination(email), github: githubReady(github),
    // The shared access phrase is checked separately after the selected provider's configuration.
    supabase: typeof supabase.url === "string" && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(supabase.url),
  };
  function authorized(header) {
    return authorizationConfigured && typeof header === "string" && header.startsWith("Bearer ") && timingSafeEqual(hash(header.slice(7)), hash(env.LAB_ACCESS_KEY));
  }
  function status(header) {
    const authenticated = authorized(header);
    return {
      enabled, authorizationConfigured, authenticated, record: RECORD, previews: PREVIEWS,
      providers: {
        supabase: { configured: configured.supabase, destination: authenticated && configured.supabase ? `${supabase.url} · ie_action_lab_reviews / NS-1041` : "Your server-configured Supabase practice table", detail: "Persist a synthetic review status, then read it independently. The course's student response tables are not used." },
        trello: { configured: configured.trello, destination: authenticated && configured.trello ? `Trello list ${trello.listId}` : "Your server-configured Trello practice list", detail: "Create one synthetic card and independently read its contents. Account plan is checked separately." },
        email: { configured: configured.email, destination: authenticated && configured.email ? email.to : "Your Resend account email, fixed on the server", detail: "Send a real email to your own address. Provider acceptance is not proof of inbox arrival." },
        github: { configured: configured.github, destination: authenticated && configured.github ? `${github.owner}/${github.repo} · base: ${github.baseBranch}` : "Your server-configured practice repository", detail: `Propose a change only to ${POLICY_FILE}. No automatic merge.` },
      },
      limits: "One reviewed action per provider. Do not repeat an uncertain request; inspect its destination first. Warm-instance request deduplication is not durable across restarts.",
    };
  }
  async function execute(action, requestId) {
    const input = { requestId, recordId: RECORD.id, ...PREVIEWS[action] };
    if (action === "supabase") {
      const saved = await functions.writeSupabaseReview(supabase, { requestId, confirmed: true });
      return { ...saved, provider: "supabase", id: RECORD.id, verification: saved.state === "verified" ? { recordId: true, status: true, requestId: true, independentRead: true } : null, message: saved.state === "verified" ? "Saved in Supabase and read back independently. Reload and read the saved review again to check persistence." : "The saved review could not be established. Read the database state before trying again." };
    }
    if (action === "trello") {
      const made = await functions.createTrelloCard(trello, input);
      if (made.state !== "created") return { ...made, provider: "trello", state: ["rejected", "unknown"].includes(made.state) ? made.state : "rejected" };
      const read = await functions.verifyTrelloCard(trello, input, made.cardId);
      return { state: read.state === "verified" ? "verified" : "unknown", provider: "trello", id: made.cardId, url: made.cardUrl, verification: read.matched || null, message: read.state === "verified" ? "Real card created; a separate GET matched its ID, list, title and description." : "Card creation was accepted, but its contents could not be verified. Inspect the card before retrying." };
    }
    if (action === "email") {
      const made = await functions.createResendEmail(email, input);
      if (made.state !== "accepted") return { ...made, provider: "email", state: ["rejected", "unknown"].includes(made.state) ? made.state : "rejected" };
      const read = await functions.verifyResendEmail(email, input, made.emailId);
      const failed = ["bounced", "complained", "failed", "suppressed", "canceled"].includes(read.deliveryState);
      return { state: failed ? "rejected" : "accepted", provider: "email", id: made.emailId, deliveryState: read.deliveryState || "unknown", inboxVerified: false, verification: read.matched || null, message: failed ? `The provider reports ${read.deliveryState}. This is not successful delivery.` : `The provider accepted the send. Latest event: ${read.deliveryState || "unknown"}. Check your actual inbox for the request ID; this panel has no mailbox access.` };
    }
    const client = functions.createGithubPrClient(github);
    const made = await client.createPolicyPullRequest({ requestId, recordId: RECORD.id, confirmed: true });
    if (made.state !== "created") return { ...made, provider: "github", state: ["rejected", "unknown"].includes(made.state) ? made.state : "rejected" };
    const read = await client.verifyPolicyPullRequest({ prNumber: made.prNumber, expectedHead: made.headBranch, expectedBase: made.baseBranch, expectedCommitSha: made.commitSha });
    return { state: read.state === "verified" ? "verified" : "unknown", provider: "github", id: made.prNumber, url: made.prUrl, verification: read.checks || null, message: read.state === "verified" ? "Real PR verified: one file changes from null to -100, with the expected branch and commit. It remains unmerged." : "The PR was created, but read-back did not establish the expected diff. Inspect it before retrying." };
  }
  async function submit(body, header) {
    if (!body || typeof body !== "object" || Array.isArray(body) || !ACTIONS.has(body.action) || body.confirmed !== true || typeof body.requestId !== "string" || !UUID.test(body.requestId) || Object.keys(body).some(key => !["action", "requestId", "confirmed"].includes(key))) {
      return { status: 400, body: { state: "rejected", message: "Confirm a supported action with a valid request ID. Source data, destinations and credentials cannot be overridden by the browser." } };
    }
    const missing = REQUIRED_ENV[body.action].filter(name => !hasValue(env[name]));
    if (missing.length) return { status: 503, body: { state: "not_configured", provider: body.action, missing, message: `Missing server configuration: ${missing.join(", ")}.` } };
    if (!configured[body.action]) {
      const configuration = body.action === "github" ? [...REQUIRED_ENV.github, "LAB_GITHUB_BASE_BRANCH", "LAB_GITHUB_POLICY_PATH"] : REQUIRED_ENV[body.action];
      return { status: 503, body: { state: "not_configured", provider: body.action, missing: [], configuration, message: `Invalid server configuration. Check: ${configuration.join(", ")}.` } };
    }
    if (!authorizationConfigured) return { status: 503, body: { state: "not_configured", provider: body.action, missing: hasValue(env.LAB_ACCESS_KEY) ? [] : ["LAB_ACCESS_KEY"], configuration: ["LAB_ACCESS_KEY"], message: "Configure LAB_ACCESS_KEY on the server with at least 24 characters; 32 or more are recommended." } };
    if (!authorized(header)) return { status: 401, body: { state: "rejected", message: "The access phrase is missing or incorrect. Enter the value configured as LAB_ACCESS_KEY on the server." } };
    const key = `${body.action}:${body.requestId}`;
    if (requests.has(key)) return { status: 200, body: await requests.get(key) };
    if (requests.size >= 20) return { status: 429, body: { state: "rejected", message: "This running test instance has reached its demonstration limit." } };
    const run = execute(body.action, body.requestId).catch(() => ({ state: "unknown", provider: body.action, message: "The result could not be established. Inspect the destination before sending again." })).then(result => ({ ...result, requestId: body.requestId, checkedAt: new Date().toISOString() }));
    requests.set(key, run);
    return { status: 200, body: await run };
  }
  async function statusWithReadback(header) {
    const result = status(header);
    if (result.authenticated && configured.supabase) result.providers.supabase.savedReview = await functions.readSupabaseReview(supabase);
    return result;
  }
  return { status, statusWithReadback, submit };
}
