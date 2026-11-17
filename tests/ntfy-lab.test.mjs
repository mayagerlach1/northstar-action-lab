import test from "node:test";
import assert from "node:assert/strict";
import { canonicalRecord, createNtfyLab } from "../server-lib/ntfy-lab.mjs";
import { jsonRoute } from "../server-lib/http.mjs";

const receiverId = "1fe82564-88f8-43e0-97f5-f7b8f62d20cb";
const requestId = "cfb0b860-cbcf-456a-9078-32f51214f8fa";
const action = { receiverId, requestId, orderId: "NS-1041", title: "Review negative margin", reason: "Review the synthetic discount and allocated freight." };
const event = {
  eventType: "ie-lab.review-request", schemaVersion: 1, synthetic: true,
  requestId, orderId: action.orderId, createdAt: "2026-11-17T16:00:00.000Z", snapshotAsOf: "2026-11-17",
  review: { title: action.title, reason: action.reason }, record: canonicalRecord(action.orderId),
};
const row = { id: "capture_123", event: "message", topic: `ie-action-lab-${receiverId}`, message: JSON.stringify(event), time: 1794931200 };
const response = (rows = [], status = 200) => new Response(rows.map((entry) => JSON.stringify(entry)).join("\n"), { status });

test("receiver generates an independent UUID topic without any provider creation call", async () => {
  let calls = 0;
  const lab = createNtfyLab({ newId: () => receiverId, fetchImpl: async () => { calls++; throw new Error("must not call"); } });
  const result = await lab.receiver({});
  assert.equal(result.status, 201);
  assert.equal(result.body.receiverId, receiverId);
  assert.equal(result.body.provider, "ntfy");
  assert.equal(result.body.viewerUrl, `https://ntfy.sh/ie-action-lab-${receiverId}`);
  assert.equal(calls, 0);
});

test("invalid values and unknown orders produce no outbound request", async () => {
  let calls = 0;
  const lab = createNtfyLab({ fetchImpl: async () => { calls++; throw new Error("must not call"); } });
  for (const change of [
    { receiverId: "https://evil.example" }, { requestId: "not-a-uuid" }, { orderId: "real-customer" },
    { title: "" }, { title: "a".repeat(141) }, { reason: "a".repeat(601) }, { url: "https://evil.example" }, { revenue: 1 },
  ]) assert.equal((await lab.send({ ...action, ...change })).status, 400);
  assert.equal((await lab.verify({ receiverId: "bad", requestId })).status, 400);
  assert.equal((await lab.receiver({ url: "https://evil.example" })).status, 400);
  assert.equal(calls, 0);
});

test("send reads first, derives actual synthetic facts and reports accepted without claiming receipt", async () => {
  const calls = [];
  const lab = createNtfyLab({ now: () => new Date(event.createdAt), fetchImpl: async (...args) => { calls.push(args); return response(); } });
  const result = await lab.send(action);
  assert.equal(result.body.state, "accepted");
  assert.equal(result.status, 202);
  assert.equal(calls.length, 2);
  const pollUrl = new URL(calls[0][0]);
  assert.equal(pollUrl.origin, "https://ntfy.sh");
  assert.equal(pollUrl.pathname, `/ie-action-lab-${receiverId}/json`);
  assert.equal(pollUrl.searchParams.get("poll"), "1");
  assert.equal(pollUrl.searchParams.get("since"), "all");
  assert.match(pollUrl.searchParams.get("_"), /^[0-9a-f-]{36}$/);
  assert.equal(calls[0][1].method, undefined);
  assert.equal(calls[0][1].cache, "no-store");
  assert.match(calls[0][1].headers["Cache-Control"], /no-cache/);
  assert.equal(calls[1][0], `https://ntfy.sh/ie-action-lab-${receiverId}`);
  assert.equal(calls[1][1].headers["Content-Type"], "text/plain; charset=utf-8");
  assert.equal(calls[1][1].redirect, "error");
  assert.deepEqual(JSON.parse(calls[1][1].body), event);
  assert.equal(event.record.profit, -120);
});

test("an actual matching capture proves receipt and avoids another POST", async () => {
  const calls = [];
  const lab = createNtfyLab({ fetchImpl: async (...args) => { calls.push(args); return response([{ event: "open" }, row]); } });
  assert.equal((await lab.send(action)).body.state, "received");
  const proof = await lab.verify({ receiverId, requestId });
  assert.equal(proof.body.captureId, row.id);
  assert.equal(proof.body.state, "received");
  assert.equal(calls.filter(([, options]) => options.method === "POST").length, 0);
  assert.notEqual(new URL(calls[0][0]).searchParams.get("_"), new URL(calls[1][0]).searchParams.get("_"));
  assert.equal((await lab.send({ ...action, reason: "Different content" })).status, 409);
});

test("mismatched request IDs, fabricated facts and non-JSON captures are never verified", async () => {
  for (const message of [
    JSON.stringify({ ...event, requestId: receiverId }),
    JSON.stringify({ ...event, record: { ...event.record, profit: 1000 } }),
    "not JSON", JSON.stringify({ requestId }),
  ]) {
    const lab = createNtfyLab({ fetchImpl: async () => response([{ ...row, message }]) });
    assert.equal((await lab.verify({ receiverId, requestId })).body.state, "unknown");
  }
});

test("duplicate captures are disclosed and a repeat is checked only after verifying the existing receipt", async () => {
  const calls = [];
  const lab = createNtfyLab({ fetchImpl: async (...args) => { calls.push(args); return response([row, { ...row, id: "capture_duplicate" }]); } });
  const verified = await lab.verify({ receiverId, requestId });
  assert.equal(verified.body.state, "received");
  assert.equal(verified.body.captureCount, 2);
  assert.equal(verified.body.warning, "DUPLICATE_CAPTURES");
  assert.equal(verified.body.duplicateCount, 1);
  const repeated = await lab.send(action);
  assert.equal(repeated.body.state, "received");
  assert.equal(repeated.body.warning, "DUPLICATE_CAPTURES");
  assert.equal(calls.filter(([, options]) => options.method === "POST").length, 0);
});

test("two existing captured actions block an additional practice publish, while existing receipts remain readable", async () => {
  let posts = 0;
  const second = { ...row, id: "capture_456", message: JSON.stringify({ ...event, requestId: "40d095f6-4ced-4438-b9dd-488bf52108cb" }) };
  const lab = createNtfyLab({ fetchImpl: async (_, options) => { if (options.method === "POST") posts++; return response([row, second]); } });
  assert.equal((await lab.send({ ...action, requestId: "3d13d6df-7103-419f-b65f-4aa927475698" })).status, 429);
  assert.equal((await lab.verify({ receiverId, requestId })).body.state, "received");
  assert.equal(posts, 0);
});

test("timeout and upstream 5xx are unknown without automatic POST retry; 4xx is rejected", async () => {
  for (const status of [403, 500, 408, "timeout"]) {
    let calls = 0;
    const lab = createNtfyLab({ fetchImpl: async () => {
      calls++;
      if (calls === 1) return response();
      if (status === "timeout") throw new DOMException("Timeout", "TimeoutError");
      return response([{ message: "provider-private-content" }], status);
    } });
    const result = await lab.send(action);
    assert.equal(result.body.state, status === 403 ? "rejected" : "unknown");
    assert.equal(calls, 2);
    assert.equal(JSON.stringify(result).includes("provider-private-content"), false);
  }
  let calls = 0;
  const unavailable = createNtfyLab({ fetchImpl: async () => { calls++; return response([], 503); } });
  assert.equal((await unavailable.send(action)).body.state, "unknown");
  assert.equal(calls, 1);
});

test("HTTP adapter rejects oversized, cross-origin and malformed requests before operation", async () => {
  let calls = 0;
  const route = jsonRoute(async () => { calls++; return { status: 200, body: {} }; });
  const run = async (req) => {
    const res = { statusCode: 0, body: "", setHeader() {}, end(body) { this.body = body; } };
    await route(req, res);
    return res;
  };
  assert.equal((await run({ method: "POST", headers: { "content-type": "application/json", "content-length": "17000" }, body: {} })).statusCode, 413);
  assert.equal((await run({ method: "POST", headers: { "content-type": "application/json", host: "localhost:3000", origin: "https://other.example" }, body: {} })).statusCode, 403);
  assert.equal((await run({ method: "POST", headers: { "content-type": "application/json" }, body: "bad json" })).statusCode, 400);
  assert.equal((await run({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).statusCode, 415);
  assert.equal(calls, 0);
});
