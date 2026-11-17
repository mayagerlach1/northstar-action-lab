import test from "node:test";
import assert from "node:assert/strict";
import { createTrelloCard, verifyTrelloCard, trelloCardPayload, trelloConfigFromEnv, validateTrelloDestination } from "./trello-card.mjs";
import { runTrelloPreflight, trelloPreflightAction } from "./preflight-trello.mjs";

// These are deliberately fake fixture credentials, never read from process.env.
const config = { apiKey: "testkey00000000000000000000000000", token: "testtoken000000000000000000000000", listId: "111111111111111111111111" };
const env = { TRELLO_API_KEY: config.apiKey, TRELLO_TOKEN: config.token, TRELLO_LIST_ID: config.listId };
const action = trelloPreflightAction("unit-trello-001");
const cardId = "222222222222222222222222";
function card(actionValue = action, changes = {}) {
  return { id: cardId, idList: config.listId, url: "https://trello.com/c/testcard/synthetic-review", ...trelloCardPayload(actionValue), ...changes };
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function ensureSanitized(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(config.apiKey), false);
  assert.equal(serialized.includes(config.token), false);
  assert.equal(serialized.includes(action.body), false);
}

test("configuration comes only from named server environment values", () => {
  assert.deepEqual(trelloConfigFromEnv({ ...env, TRELLO_BOARD_ID: "ignored" }), config);
  assert.equal(validateTrelloDestination(config), true);
  assert.equal(validateTrelloDestination({ ...config, token: 'invalid"header' }), false);
  assert.equal(validateTrelloDestination({ ...config, listId: "https://other.example" }), false);
});

test("invalid actions or destinations make no network request", async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls += 1; throw new Error("Must not fetch"); } };
  for (const badAction of [null, { ...action, requestId: ["array-id"] }, { ...action, recordId: 42 },
    { ...action, title: "line\ninjection" }, { ...action, body: "" }, { ...action, requestId: "../escape" }]) {
    assert.equal((await createTrelloCard(config, badAction, options)).state, "invalid");
  }
  assert.equal((await createTrelloCard({ ...config, listId: "../other" }, action, options)).state, "invalid");
  assert.equal((await createTrelloCard(config, action, { ...options, timeoutMs: 0 })).state, "invalid");
  assert.equal((await verifyTrelloCard(config, action, "../other", options)).state, "invalid");
  assert.equal(calls, 0);
});

test("create posts one synthetic card to the configured list with auth only in headers", async () => {
  let calls = 0;
  const result = await createTrelloCard(config, { ...action, idList: "attacker", token: "ignored" }, {
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://api.trello.com/1/cards");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization.includes(config.token), true);
      assert.deepEqual(JSON.parse(options.body), { ...trelloCardPayload(action), idList: config.listId });
      assert.equal(options.body.includes(config.token), false);
      return json(card());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "created");
  assert.equal(result.cardId, cardId);
  ensureSanitized(result);
});

test("readback independently checks exact card, destination, title and complete body", async () => {
  let calls = 0;
  const result = await verifyTrelloCard(config, action, cardId, {
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, `https://api.trello.com/1/cards/${cardId}?fields=id,name,desc,idList,url`);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      return json(card());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.state, "verified");
  assert.deepEqual(result.matched, { id: true, list: true, title: true, body: true });
  ensureSanitized(result);
});

test("foreign cards, edited content or unsafe links cannot count as verified", async () => {
  for (const changes of [{ id: "333333333333333333333333" }, { idList: "333333333333333333333333" },
    { name: "Different title" }, { desc: "Different body" }, { url: "https://other.example/c/card" },
    { url: "https://trello.com/c/card?secret=bad" }]) {
    const result = await verifyTrelloCard(config, action, cardId, { fetchImpl: async () => json(card(action, changes)) });
    assert.equal(result.state, "mismatch");
    ensureSanitized(result);
  }
});

test("provider errors are sanitized and ambiguous failures never trigger a retry", async () => {
  for (const [status, expected] of [[401, "rejected"], [403, "rejected"], [429, "rejected"], [408, "unknown"], [500, "unknown"]]) {
    let calls = 0;
    const result = await createTrelloCard(config, action, { fetchImpl: async () => {
      calls += 1; return json({ secret: config.token, detail: action.body }, status);
    } });
    assert.equal(result.state, expected);
    assert.equal(calls, 1);
    ensureSanitized(result);
  }
  let calls = 0;
  const result = await createTrelloCard(config, action, { fetchImpl: async () => { calls += 1; throw new Error(config.token); } });
  assert.equal(result.state, "unknown");
  assert.equal(calls, 1);
  ensureSanitized(result);
});

test("malformed or mismatched create success remains unknown", async () => {
  for (const response of [json({ id: cardId }), json(card(action, { desc: "changed" })), new Response("not-json")]) {
    assert.equal((await createTrelloCard(config, action, { fetchImpl: async () => response })).state, "unknown");
  }
  assert.equal((await verifyTrelloCard(config, action, cardId, { fetchImpl: async () => json({ error: config.token }, 403) })).state, "unknown");
});

test("preflight blocks absent configuration, missing opt-in and invalid arguments before fetch", async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls += 1; throw new Error("Must not fetch"); } };
  for (const [args, environment] of [[[], {}], [["--send"], {}], [[], env], [["--send", "--unknown"], env],
    [["--verify-only", cardId], env], [["--send", "--request-id", "bad/id"], env],
    [["--send", "--verify-only", cardId], env]]) {
    const { report, exitCode } = await runTrelloPreflight(args, environment, options);
    assert.equal(exitCode, 2);
    assert.equal(report.state, "blocked");
    ensureSanitized(report);
  }
  assert.equal(calls, 0);
});

test("preflight creates once, reads once, and never claims a verified Free plan", async () => {
  const methods = [];
  const { report, exitCode } = await runTrelloPreflight(["--send", "--request-id", action.requestId], env, {
    fetchImpl: async (_url, options) => { methods.push(options.method); return json(card()); },
  });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(exitCode, 0);
  assert.equal(report.liveVerified, true);
  assert.equal(report.accountPlan.state, "not_verified");
  ensureSanitized(report);
});

test("preflight recovery uses GET only and ambiguous POST stops without another action", async () => {
  const methods = [];
  const recovery = await runTrelloPreflight(["--verify-only", cardId, "--request-id", action.requestId], env, {
    fetchImpl: async (_url, options) => { methods.push(options.method); return json(card()); },
  });
  assert.deepEqual(methods, ["GET"]);
  assert.equal(recovery.report.liveVerified, true);
  let calls = 0;
  const failed = await runTrelloPreflight(["--send"], env, {
    fetchImpl: async () => { calls += 1; throw new Error(config.token); },
  });
  assert.equal(calls, 1);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.report.liveVerified, false);
  ensureSanitized(failed.report);
});
