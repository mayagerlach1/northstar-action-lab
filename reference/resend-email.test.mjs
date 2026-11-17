import test from "node:test";
import assert from "node:assert/strict";
import { createResendEmail, verifyResendEmail, resendEmailPayload, resendConfigFromEnv, validateResendDestination } from "./resend-email.mjs";
import { runEmailPreflight, emailPreflightAction } from "./preflight-email.mjs";

// Deliberately fake fixtures. Tests never access process.env or the real service.
const config = { apiKey: "re_testfixture0000000000000000", to: "owner@example.com" };
const env = { RESEND_API_KEY: config.apiKey, LAB_EMAIL_TO: config.to };
const action = emailPreflightAction("unit-email-001");
const emailId = "11111111-2222-4333-8444-555555555555";
function email(actionValue = action, changes = {}) {
  return { id: emailId, ...resendEmailPayload(config, actionValue), cc: [], bcc: [], last_event: "delivered", ...changes };
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function ensureSanitized(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(config.apiKey), false);
  assert.equal(serialized.includes(config.to), false);
  assert.equal(serialized.includes(action.body), false);
}

test("server config fixes the recipient and excludes simulated Resend recipients", () => {
  assert.deepEqual(resendConfigFromEnv({ ...env, RESEND_FROM: "ignored@example.com" }), config);
  assert.equal(validateResendDestination(config), true);
  for (const to of ["delivered@resend.dev", "owner@example.com\nBcc: other@example.com", "a@example.com,b@example.com"]) {
    assert.equal(validateResendDestination({ ...config, to }), false);
  }
});

test("bad actions, configuration or external IDs cannot trigger any HTTP request", async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls += 1; throw new Error("Must not fetch"); } };
  for (const badAction of [null, { ...action, requestId: ["array"] }, { ...action, recordId: 123 },
    { ...action, title: "subject\r\ninjection" }, { ...action, body: "" }, { ...action, requestId: "../escape" }]) {
    assert.equal((await createResendEmail(config, badAction, options)).state, "invalid");
  }
  assert.equal((await createResendEmail({ ...config, apiKey: "invalid" }, action, options)).state, "invalid");
  assert.equal((await createResendEmail(config, action, { ...options, timeoutMs: -1 })).state, "invalid");
  assert.equal((await verifyResendEmail(config, action, "../escape", options)).state, "invalid");
  assert.equal(calls, 0);
});

test("one POST uses fixed sender/recipient and a stable request-scoped idempotency key", async () => {
  const keys = [];
  const options = { fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    keys.push(init.headers["Idempotency-Key"]);
    assert.equal(init.headers.Authorization.startsWith("Bearer "), true);
    assert.deepEqual(JSON.parse(init.body), resendEmailPayload(config, action));
    assert.equal(init.body.includes(config.apiKey), false);
    return json({ id: emailId });
  } };
  const input = { ...action, to: "ignored@example.com", from: "ignored@example.com", cc: ["ignored@example.com"] };
  const first = await createResendEmail(config, input, options);
  const repeatedExplicitCall = await createResendEmail(config, input, options);
  assert.deepEqual(keys, [`ie-lab-email/${action.requestId}`, `ie-lab-email/${action.requestId}`]);
  assert.equal(first.state, "accepted");
  assert.equal(first.deliveryState, "accepted");
  assert.equal(first.inboxVerified, false);
  assert.equal(repeatedExplicitCall.emailId, emailId);
  ensureSanitized(first);
});

test("exact independent readback confirms provider delivery but never inbox arrival", async () => {
  const result = await verifyResendEmail(config, action, emailId, { fetchImpl: async (url, init) => {
    assert.equal(url, `https://api.resend.com/emails/${emailId}`);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    return json(email());
  } });
  assert.equal(result.state, "matched");
  assert.equal(result.deliveryState, "delivered");
  assert.equal(result.inboxVerified, false);
  assert.deepEqual(result.matched, { id: true, recipient: true, sender: true, subject: true, body: true });
  ensureSanitized(result);
});

test("readback distinguishes accepted, bounced, delayed and unknown provider events", async () => {
  for (const [event, expected] of [["sent", "accepted"], ["bounced", "bounced"], ["delivery_delayed", "delayed"],
    ["failed", "failed"], ["suppressed", "suppressed"], ["complained", "complained"], ["unrecognized", "unknown"]]) {
    const result = await verifyResendEmail(config, action, emailId, { fetchImpl: async () => json(email(action, { last_event: event })) });
    assert.equal(result.state, "matched");
    assert.equal(result.deliveryState, expected);
    assert.equal(result.inboxVerified, false);
  }
});

test("wrong IDs, recipients, sender, content or extra recipients cannot be verified", async () => {
  for (const changes of [{ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, { to: ["other@example.com"] },
    { to: [config.to, "other@example.com"] }, { from: "other@example.com" }, { subject: "Different" },
    { text: "Different" }, { cc: ["other@example.com"] }, { bcc: "not-an-array" }]) {
    const result = await verifyResendEmail(config, action, emailId, { fetchImpl: async () => json(email(action, changes)) });
    assert.equal(result.state, "mismatch");
    assert.equal(result.inboxVerified, false);
    ensureSanitized(result);
  }
});

test("rejections and ambiguous errors remain sanitized and never retry", async () => {
  for (const [status, expected] of [[401, "rejected"], [403, "rejected"], [409, "unknown"], [429, "rejected"], [408, "unknown"], [503, "unknown"]]) {
    let calls = 0;
    const result = await createResendEmail(config, action, { fetchImpl: async () => {
      calls += 1; return json({ apiKey: config.apiKey, recipient: config.to }, status);
    } });
    assert.equal(result.state, expected);
    assert.equal(calls, 1);
    ensureSanitized(result);
  }
  let calls = 0;
  const result = await createResendEmail(config, action, { fetchImpl: async () => { calls += 1; throw new Error(config.apiKey); } });
  assert.equal(result.state, "unknown");
  assert.equal(calls, 1);
  ensureSanitized(result);
});

test("malformed success and unavailable readback are never declared delivered", async () => {
  for (const response of [json({ id: "bad" }), new Response("not-json")]) {
    assert.equal((await createResendEmail(config, action, { fetchImpl: async () => response })).state, "unknown");
  }
  const result = await verifyResendEmail(config, action, emailId, { fetchImpl: async () => json({ error: config.apiKey }, 403) });
  assert.equal(result.state, "unknown");
  assert.equal(result.inboxVerified, false);
  ensureSanitized(result);
});

test("CLI preflight requires configuration and an explicit operation without any HTTP", async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls += 1; throw new Error("Must not fetch"); } };
  for (const [args, environment] of [[[], {}], [["--send"], {}], [[], env], [["--send", "--bad"], env],
    [["--verify-only", emailId], env], [["--send", "--request-id", "bad/id"], env],
    [["--send", "--verify-only", emailId], env]]) {
    const { report, exitCode } = await runEmailPreflight(args, environment, options);
    assert.equal(exitCode, 2);
    assert.equal(report.state, "blocked");
    ensureSanitized(report);
  }
  assert.equal(calls, 0);
});

test("preflight accepted send plus readback does not claim delivery or Free account tier", async () => {
  const methods = [];
  const { report, exitCode } = await runEmailPreflight(["--send", "--request-id", action.requestId], env, {
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      return json(init.method === "POST" ? { id: emailId } : email(action, { last_event: "sent" }));
    },
  });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(exitCode, 0);
  assert.equal(report.providerReadbackVerified, true);
  assert.equal(report.deliveryConfirmed, false);
  assert.equal(report.state, "delivery_pending");
  assert.equal(report.inboxVerified, false);
  assert.equal(report.accountPlan.state, "not_verified");
  ensureSanitized(report);
});

test("read-only preflight can observe delivery or bounce without sending again", async () => {
  for (const [event, state, exitCode] of [["delivered", "provider_delivered", 0], ["bounced", "delivery_failed", 1]]) {
    const methods = [];
    const result = await runEmailPreflight(["--verify-only", emailId, "--request-id", action.requestId], env, {
      fetchImpl: async (_url, init) => { methods.push(init.method); return json(email(action, { last_event: event })); },
    });
    assert.deepEqual(methods, ["GET"]);
    assert.equal(result.report.state, state);
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.report.inboxVerified, false);
    assert.equal(result.report.deliveryConfirmed, event === "delivered");
  }
});

test("unknown send preflight stops after one attempt and cannot report a successful test", async () => {
  let calls = 0;
  const { report, exitCode } = await runEmailPreflight(["--send"], env, {
    fetchImpl: async () => { calls += 1; throw new Error(config.apiKey); },
  });
  assert.equal(calls, 1);
  assert.equal(exitCode, 1);
  assert.equal(report.providerReadbackVerified, false);
  assert.equal(report.deliveryConfirmed, false);
  ensureSanitized(report);
});
