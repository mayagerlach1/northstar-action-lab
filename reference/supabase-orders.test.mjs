import test from "node:test";
import assert from "node:assert/strict";
import { readSupabaseOrders, updateSupabaseOrder, validAmount, validateSupabaseOrdersConfig } from "./supabase-orders.mjs";
const config = { url: "https://abcdefghijklmnopqrst.supabase.co", accessKey: "test-key-with-at-least-thirty-two-characters" };
const change = { recordId: "NS-1041", field: "cost", expectedValue: 1320, newValue: 1080, expectedRevision: 0, reason: "Documented duplicate cost", requestId: "00000000-0000-4000-8000-000000000001", confirmed: true };
const row = { recordId: "NS-1041", revenue: 1200, cost: 1080, refund: 0, revision: 1, updatedAt: "2026-11-17T20:00:00Z" };
test("invalid change is rejected before network access", async () => {
  let calls = 0; const options = { fetchImpl: async () => { calls++; } };
  assert.equal((await updateSupabaseOrder(config, { ...change, field: "token" }, options)).state, "rejected");
  assert.equal((await updateSupabaseOrder(config, { ...change, newValue: -1 }, options)).state, "rejected"); assert.equal(calls, 0);
});
test("CAS conflict and timeout never retry the write", async () => {
  let calls = 0;
  const conflict = await updateSupabaseOrder(config, change, { fetchImpl: async () => { calls++; return new Response("{}", { status: 409 }); } });
  assert.equal(conflict.state, "conflict"); assert.equal(calls, 1);
  const unknown = await updateSupabaseOrder(config, change, { fetchImpl: async () => { calls++; throw new Error("timeout"); } });
  assert.equal(unknown.state, "unknown"); assert.equal(calls, 2);
});
test("successful mutation still requires a matching independent read", async () => {
  let calls = 0;
  const result = await updateSupabaseOrder(config, change, { fetchImpl: async (_url, init) => {
    calls++; return Response.json(init.method === "POST" ? { state: "verified", requestId: change.requestId, record: row } : { state: "verified", records: [{ ...row, cost: 1320 }] });
  } });
  assert.equal(result.state, "unknown"); assert.equal(result.code, "WRITE_READBACK_MISMATCH"); assert.equal(calls, 2);
});
test("malformed duplicate database rows cannot be accepted", async () => {
  assert.equal((await readSupabaseOrders(config, { fetchImpl: async () => Response.json({ state: "verified", records: [row, row] }) })).state, "unknown");
});
test("amounts match the Edge contract and database refunds cannot exceed revenue", async () => {
  for (const amount of [0, 0.00001, 1080.123456, 1000000000]) assert.equal(validAmount(amount), true);
  for (const amount of [-1, Infinity, NaN, 1000000001, "1"]) assert.equal(validAmount(amount), false);
  const read = await readSupabaseOrders(config, { fetchImpl: async () => Response.json({ state: "verified", records: [{ ...row, refund: row.revenue + 1 }] }) });
  assert.equal(read.state, "unknown");
});
test("Supabase transport enforces the same 32–256 character key limits", () => {
  for (const length of [31, 257]) assert.equal(validateSupabaseOrdersConfig({ ...config, accessKey: "a".repeat(length) }), false);
  for (const length of [32, 256]) assert.equal(validateSupabaseOrdersConfig({ ...config, accessKey: "a".repeat(length) }), true);
});
