import test from "node:test";
import assert from "node:assert/strict";
import { createPreflightService } from "../server-lib/action-preflight.mjs";
const requestId = "983a14ba-4850-4d3b-87d0-d5aa8771f7cc";
const access = "classroom-test-access-phrase-12345";
const env = {
  LAB_ACCESS_KEY: access,
  TRELLO_API_KEY: "a".repeat(32), TRELLO_TOKEN: "b".repeat(64), TRELLO_LIST_ID: "c".repeat(24),
  RESEND_API_KEY: `re_${"a".repeat(32)}`, LAB_EMAIL_TO: "teacher@example.org",
  LAB_GITHUB_TOKEN: "github-test-token", LAB_GITHUB_REPOSITORY: "classroom/action-lab",
  LAB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
};
const input = { action: "trello", requestId, confirmed: true };
const transportNames = ["createTrelloCard", "verifyTrelloCard", "createResendEmail", "verifyResendEmail", "createGithubPrClient", "readSupabaseReview", "writeSupabaseReview"];

test("actions remain available and identify missing provider variables without any outbound call", async () => {
  let calls = 0;
  const service = createPreflightService({ env: {}, transports: Object.fromEntries(transportNames.map(name => [name, () => { calls++; throw new Error("Unexpected outbound call"); }])) });
  const required = {
    trello: ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LIST_ID"], email: ["RESEND_API_KEY", "LAB_EMAIL_TO"],
    github: ["LAB_GITHUB_TOKEN", "LAB_GITHUB_REPOSITORY"], supabase: ["LAB_SUPABASE_URL"],
  };
  assert.equal(service.status().enabled, true);
  assert.equal(service.status().authenticated, false);
  for (const [action, missing] of Object.entries(required)) {
    const result = await service.submit({ ...input, action });
    assert.equal(result.status, 503); assert.equal(result.body.state, "not_configured");
    assert.deepEqual(result.body.missing, missing);
    for (const name of missing) assert.equal(result.body.message.includes(name), true);
  }
  await service.statusWithReadback();
  assert.equal(calls, 0);
});

test("unconfigured values are distinguished from present but invalid provider settings", async () => {
  const partial = createPreflightService({ env: { RESEND_API_KEY: env.RESEND_API_KEY } });
  assert.deepEqual((await partial.submit({ ...input, action: "email" })).body.missing, ["LAB_EMAIL_TO"]);
  const invalid = createPreflightService({ env: { ...env, LAB_SUPABASE_URL: "https://untrusted.example" } });
  const result = await invalid.submit({ ...input, action: "supabase" }, `Bearer ${access}`);
  assert.equal(result.status, 503); assert.deepEqual(result.body.missing, []);
  assert.deepEqual(result.body.configuration, ["LAB_SUPABASE_URL"]);
});

test("legacy opt-in flag cannot disable a configured authorized action or publish secrets", async () => {
  let writes = 0;
  const service = createPreflightService({ env: { ...env, LAB_PREFLIGHT_ENABLED: "false" }, transports: {
    createTrelloCard: async () => { writes++; return { state: "created", cardId: "d".repeat(24), cardUrl: "https://trello.com/c/abc123" }; },
    verifyTrelloCard: async () => ({ state: "verified", matched: { id: true } }),
  } });
  assert.equal((await service.submit(input, `Bearer ${access}`)).body.state, "verified");
  assert.equal(writes, 1);
  const status = JSON.stringify(service.status());
  for (const value of [access, env.TRELLO_API_KEY, env.TRELLO_TOKEN, env.RESEND_API_KEY, env.LAB_EMAIL_TO, env.LAB_GITHUB_TOKEN]) assert.equal(status.includes(value), false);
});

test("payload validation runs before configuration and authorization without provider calls", async () => {
  let calls = 0;
  const service = createPreflightService({ env: {}, transports: Object.fromEntries(transportNames.map(name => [name, () => { calls++; }])) });
  for (const body of [null, [], {}, { ...input, confirmed: false }, { ...input, requestId: 123 }, { ...input, action: "arbitrary" }, { ...input, listId: "attacker" }]) {
    assert.equal((await service.submit(body)).status, 400);
  }
  assert.equal(calls, 0);
});

test("configured providers require a server access key and authentication before effects", async () => {
  let calls = 0;
  const transports = Object.fromEntries(transportNames.map(name => [name, () => { calls++; } ]));
  for (const key of [undefined, "too-short"]) {
    const service = createPreflightService({ env: { ...env, LAB_ACCESS_KEY: key }, transports });
    for (const action of ["trello", "email", "github", "supabase"]) {
      const result = await service.submit({ ...input, action }, `Bearer ${access}`);
      assert.equal(result.status, 503); assert.match(result.body.message, /LAB_ACCESS_KEY/);
      assert.deepEqual(result.body.configuration, ["LAB_ACCESS_KEY"]);
    }
    await service.statusWithReadback(`Bearer ${access}`);
  }
  const service = createPreflightService({ env, transports });
  for (const action of ["trello", "email", "github", "supabase"]) {
    assert.equal((await service.submit({ ...input, action }, "Bearer incorrect")).status, 401);
    assert.equal((await service.submit({ ...input, action })).status, 401);
  }
  await service.statusWithReadback("Bearer incorrect");
  assert.equal(calls, 0);
});

test("authentication, confirmation and destination restrictions precede any provider call", async () => {
  let calls = 0;
  const service = createPreflightService({ env, transports: { createTrelloCard: async () => { calls++; } } });
  assert.equal((await service.submit(input, "Bearer incorrect")).status, 401);
  assert.equal((await service.submit({ ...input, confirmed: false }, `Bearer ${access}`)).status, 400);
  assert.equal((await service.submit({ ...input, listId: "attacker" }, `Bearer ${access}`)).status, 400);
  assert.equal((await service.submit({ ...input, action: "arbitrary" }, `Bearer ${access}`)).status, 400);
  assert.equal(calls, 0);
  assert.equal(service.status("Bearer incorrect").authenticated, false);
  assert.equal(service.status(`Bearer ${access}`).authenticated, true);
  assert.equal(service.status(`Bearer ${access}`).providers.email.destination, env.LAB_EMAIL_TO);
});

test("concurrent identical requests perform one write and require separate exact read-back", async () => {
  let writes = 0; let reads = 0;
  const service = createPreflightService({ env, transports: {
    createTrelloCard: async (config, action) => {
      writes++; assert.equal(config.listId, env.TRELLO_LIST_ID); assert.equal(action.recordId, "NS-1041");
      return { state: "created", cardId: "d".repeat(24), cardUrl: "https://trello.com/c/abc123" };
    },
    verifyTrelloCard: async () => { reads++; return { state: "verified", matched: { id: true, title: true, body: true, list: true } }; },
  } });
  assert.equal(Object.hasOwn(env, "LAB_PREFLIGHT_ENABLED"), false);
  assert.equal((await service.submit(input, "Bearer incorrect")).status, 401);
  const results = await Promise.all([service.submit(input, `Bearer ${access}`), service.submit(input, `Bearer ${access}`)]);
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(results[0].body.state, "verified");
  assert.deepEqual(results[0].body, results[1].body);
});

test("an uncertain action is retained for the same request and never automatically written again", async () => {
  let writes = 0;
  const service = createPreflightService({ env, transports: {
    createTrelloCard: async () => { writes++; throw new Error("Response lost after a possible write"); },
  } });
  const first = await service.submit(input, `Bearer ${access}`);
  const repeated = await service.submit(input, `Bearer ${access}`);
  assert.equal(first.body.state, "unknown"); assert.equal(writes, 1);
  assert.deepEqual(first.body, repeated.body);
});

test("failed read-back never turns a created card into verified success", async () => {
  const service = createPreflightService({ env, transports: {
    createTrelloCard: async () => ({ state: "created", cardId: "d".repeat(24), cardUrl: "https://trello.com/c/abc123" }),
    verifyTrelloCard: async () => ({ state: "mismatch" }),
  } });
  const result = await service.submit(input, `Bearer ${access}`);
  assert.equal(result.body.state, "unknown"); assert.equal(result.body.url, "https://trello.com/c/abc123");
});

test("email provider delivery remains distinct from inbox verification", async () => {
  const service = createPreflightService({ env, transports: {
    createResendEmail: async () => ({ state: "accepted", emailId: requestId }),
    verifyResendEmail: async () => ({ state: "matched", deliveryState: "delivered", matched: { id: true } }),
  } });
  const result = await service.submit({ ...input, action: "email" }, `Bearer ${access}`);
  assert.equal(result.body.state, "accepted"); assert.equal(result.body.deliveryState, "delivered"); assert.equal(result.body.inboxVerified, false);
});
