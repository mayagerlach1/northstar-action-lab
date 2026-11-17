import test from "node:test";
import assert from "node:assert/strict";
import { readSupabaseReview, writeSupabaseReview } from "../reference/supabase-writeback.mjs";
const config = { url: "https://abcdefghijklmnopqrst.supabase.co", accessKey: "test-access-key-123456789012345" };
const requestId = "2cc90098-f630-441c-b072-2ae527143e35";
const record = { recordId: "NS-1041", reviewStatus: "reviewed", reviewedAt: "2026-11-17T17:00:00Z", requestId, synthetic: true };
const json = data => new Response(JSON.stringify(data), { status: 200 });
test("write-back verifies persistence with a separate authenticated GET", async () => {
  const methods = [];
  const result = await writeSupabaseReview(config, { requestId, confirmed: true }, { fetchImpl: async (url, options) => {
    assert.equal(url, `${config.url}/functions/v1/ie-action-lab-writeback`);
    assert.equal(options.headers["x-lab-access-key"], config.accessKey);
    methods.push(options.method);
    return json({ state: options.method === "POST" ? "persisted" : "read", record });
  } });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(result.state, "verified"); assert.equal(result.requestId, requestId);
  assert.equal(JSON.stringify(result).includes(config.accessKey), false);
});
test("a cancelled write never calls the provider and changed read-back cannot verify", async () => {
  const none = await writeSupabaseReview(config, { requestId, confirmed: false }, { fetchImpl: () => { throw new Error("Unexpected call"); } });
  assert.equal(none.state, "rejected");
  const result = await writeSupabaseReview(config, { requestId, confirmed: true }, { fetchImpl: async (_url, options) => json({ state: options.method === "POST" ? "persisted" : "read", record: { ...record, requestId: options.method === "POST" ? requestId : "5cc90098-f630-441c-b072-2ae527143e35" } }) });
  assert.equal(result.state, "unknown");
});
test("GET distinguishes initial pending state from a broken provider response", async () => {
  assert.equal((await readSupabaseReview(config, { fetchImpl: async () => json({ state: "read", record: { ...record, reviewStatus: "pending", requestId: null } }) })).state, "not_found");
  assert.equal((await readSupabaseReview(config, { fetchImpl: async () => json({ error: "unexpected" }) })).state, "unknown");
});
