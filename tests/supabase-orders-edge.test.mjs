import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

// Load the dependency-free Edge handler without starting the Deno server.
const source = await readFile(new URL("../supabase/orders/index.ts", import.meta.url), "utf8");
const javascript = stripTypeScriptTypes(source, { mode: "strip" });
const { createOrdersHandler, ORDER_IDS } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
let dataset;
try { dataset = JSON.parse(await readFile(new URL("../public/data.json", import.meta.url), "utf8")); }
catch { dataset = JSON.parse(await readFile(new URL("../../../public/apps-lab/data.json", import.meta.url), "utf8")); }
const accessKey = "synthetic-test-password-0000000000000000";
const config = {
  expectedHash: createHash("sha256").update(accessKey).digest("hex"),
  supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
  serviceRoleKey: "synthetic-service-key-for-unit-tests",
};
const requestId = "11111111-2222-4333-8444-555555555555";
const secondRequestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const change = {
  recordId: "NS-1041", field: "cost", newValue: 900, expectedValue: 1320,
  expectedRevision: 0, reason: "Correct allocated freight using the practice invoice.",
  requestId, confirmed: true,
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function request(body, method = body === undefined ? "GET" : "POST", key = accessKey) {
  return new Request("https://example.invalid/functions/v1/ie-action-lab-orders", {
    method, headers: { "x-lab-access-key": key, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fakeDatabase(options = {}) {
  const rows = dataset.orders.map((order) => ({
    record_id: order.id, revenue: order.revenue, cost: order.cost, refund: order.refund,
    revision: 0, updated_at: "2026-11-17T12:00:00.000Z", update_reason: null,
    last_request_id: null, last_change_field: null, last_previous_value: null,
    last_new_value: null, last_expected_revision: null,
  }));
  const calls = [];
  let writes = 0;
  return {
    rows, calls, get writes() { return writes; },
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      assert.equal(url.origin, config.supabaseUrl);
      assert.equal(url.pathname, "/rest/v1/ie_action_lab_order_values");
      assert.equal(init.headers.apikey, config.serviceRoleKey);
      assert.equal(init.headers.Authorization.startsWith("Bearer "), true);
      assert.equal(init.redirect, "error");
      const filter = url.searchParams.get("record_id");
      const selected = filter ? rows.filter((row) => row.record_id === filter.slice(3)) : rows;
      if (init.method === "GET") {
        if (options.failReadAfterWrite && writes) throw new Error(config.serviceRoleKey);
        return json(structuredClone(selected));
      }
      assert.equal(init.method, "PATCH");
      assert.equal(init.headers.Prefer, "return=representation");
      if (options.patchStatus) return json({ secret: config.serviceRoleKey }, options.patchStatus);
      if (options.patchThrows) throw new Error(config.serviceRoleKey);
      const update = JSON.parse(init.body);
      const row = selected[0];
      const field = update.last_change_field;
      if (!row || Number(url.searchParams.get("revision")?.slice(3)) !== row.revision ||
        Number(url.searchParams.get(field)?.slice(3)) !== row[field]) return json([]);
      Object.assign(row, update);
      writes += 1;
      if (options.afterWrite) options.afterWrite(row);
      return options.malformedPatchResponse ? new Response("not-json")
        : json([{ record_id: row.record_id, revision: update.revision }]);
    },
  };
}
function assertSanitized(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [accessKey, config.serviceRoleKey, config.expectedHash]) assert.equal(serialized.includes(secret), false);
}

test("SQL seeds the 24 exact numeric fixtures without overwriting existing corrections", async () => {
  const sql = await readFile(new URL("../supabase/orders-setup.sql", import.meta.url), "utf8");
  const seeds = [...sql.matchAll(/\('(NS-\d+)', ([\d.]+), ([\d.]+), ([\d.]+)\)/g)]
    .map(([, id, revenue, cost, refund]) => ({ id, revenue: Number(revenue), cost: Number(cost), refund: Number(refund) }));
  assert.deepEqual(seeds, dataset.orders.map(({ id, revenue, cost, refund }) => ({ id, revenue, cost, refund })));
  assert.deepEqual(ORDER_IDS, dataset.orders.map((order) => order.id));
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all.*from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant select, update.*to service_role/i);
  assert.match(sql, /refund <= revenue/);
  assert.match(sql, /on conflict \(record_id\) do nothing/i);
  assert.equal(sql.includes("ie_action_lab_reviews"), false);
  assert.equal(sql.includes("numeric("), false, "No implicit two-decimal rounding in the DB");
});

test("authorization and configuration failures cannot reach the database", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("Must not fetch"); };
  const handler = createOrdersHandler(config, fetchImpl);
  assert.equal((await handler(request(undefined, "GET", "wrong-password-0000000000000000000000"))).status, 401);
  assert.equal((await handler(request(change, "POST", "short"))).status, 401);
  assert.equal((await createOrdersHandler({ ...config, expectedHash: "placeholder" }, fetchImpl)(request())).status, 503);
  assert.equal((await createOrdersHandler({ ...config, supabaseUrl: "https://other.example" }, fetchImpl)(request())).status, 503);
  assert.equal((await handler(request(undefined, "DELETE"))).status, 405);
  assert.equal(calls, 0);
});

test("GET returns all real database numeric values without service credentials or private metadata", async () => {
  const db = fakeDatabase();
  const response = await createOrdersHandler(config, db.fetch)(request());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.state, "verified");
  assert.equal(result.records.length, 24);
  assert.deepEqual(result.records[0], {
    recordId: "NS-1041", revenue: 1200, cost: 1320, refund: 0, revision: 0, updatedAt: "2026-11-17T12:00:00.000Z",
  });
  assert.equal(result.records[0].last_request_id, undefined);
  assertSanitized(result);
});

test("invalid numeric changes are rejected before any database request", async () => {
  let calls = 0;
  const handler = createOrdersHandler(config, async () => { calls += 1; throw new Error("Must not fetch"); });
  for (const invalid of [null, [], { ...change, recordId: "NS-9999" }, { ...change, field: "owner" },
    { ...change, newValue: "900" }, { ...change, newValue: -1 }, { ...change, newValue: 1e9 + 1 },
    { ...change, newValue: Infinity }, { ...change, expectedValue: null },
    { ...change, expectedRevision: 0.5 }, { ...change, expectedRevision: -1 },
    { ...change, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...change, reason: "no" },
    { ...change, reason: "x".repeat(601) }, { ...change, requestId: "not-uuid" },
    { ...change, newValue: change.expectedValue }, { ...change, confirmed: false },
    { ...change, endpoint: "https://other.example" }]) {
    const response = await handler(request(invalid));
    assert.equal(response.status, 400);
    assertSanitized(await response.json());
  }
  assert.equal(calls, 0);
});

test("bounded parsing rejects oversized streamed bodies and wrong content types", async () => {
  let calls = 0;
  const handler = createOrdersHandler(config, async () => { calls += 1; throw new Error("Must not fetch"); });
  const oversized = new Request("https://example.invalid", { method: "POST", headers: {
    "x-lab-access-key": accessKey, "Content-Type": "application/json",
  }, body: JSON.stringify({ ...change, reason: "x".repeat(5000) }) });
  const wrongType = new Request("https://example.invalid", { method: "POST", headers: {
    "x-lab-access-key": accessKey, "Content-Type": "text/plain",
  }, body: JSON.stringify(change) });
  assert.equal((await handler(oversized)).status, 400);
  assert.equal((await handler(wrongType)).status, 400);
  assert.equal(calls, 0);
});

test("numeric correction changes actual cost and metrics, then independently reads it back", async () => {
  const db = fakeDatabase();
  const beforeProfit = db.rows.reduce((total, row) => total + row.revenue - row.refund - row.cost, 0);
  const handler = createOrdersHandler(config, db.fetch);
  const response = await handler(request(change));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.state, "verified");
  assert.equal(result.record.cost, 900);
  assert.equal(result.record.revision, 1);
  assert.equal(result.record.revenue - result.record.refund - result.record.cost, 300);
  assert.deepEqual(result.change, { field: "cost", oldValue: 1320, newValue: 900 });
  assert.equal(result.requestId, requestId);
  assert.deepEqual(db.calls.map((call) => call.init.method), ["GET", "PATCH", "GET"]);
  const patch = db.calls[1];
  assert.equal(patch.url.searchParams.get("revision"), "eq.0");
  assert.equal(patch.url.searchParams.get("cost"), "eq.1320");
  const patchedFields = JSON.parse(patch.init.body);
  assert.equal(patchedFields.revenue, undefined);
  assert.equal(patchedFields.refund, undefined);
  const reload = await (await handler(request())).json();
  const afterProfit = reload.records.reduce((total, row) => total + row.revenue - row.refund - row.cost, 0);
  assert.equal(afterProfit - beforeProfit, 420);
  assert.equal(db.writes, 1);
  assertSanitized(result);
});

test("fractional values survive without implicit rounding and every allowed field is editable", async () => {
  for (const [field, newValue, expectedValue] of [["revenue", 1250.123, 1200], ["cost", 900.123, 1320], ["refund", 25.125, 0]]) {
    const db = fakeDatabase();
    const response = await createOrdersHandler(config, db.fetch)(request({ ...change, field, newValue, expectedValue }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).record[field], newValue);
    assert.equal(db.writes, 1);
  }
});

test("refund cannot exceed revenue, including when revenue is reduced", async () => {
  const db = fakeDatabase();
  const handler = createOrdersHandler(config, db.fetch);
  const tooHighRefund = await handler(request({ ...change, field: "refund", expectedValue: 0, newValue: 1201 }));
  assert.equal(tooHighRefund.status, 400);
  const reducedRevenue = await handler(request({ ...change, recordId: "NS-1048", field: "revenue", expectedValue: 900, newValue: 400 }));
  assert.equal(reducedRevenue.status, 400);
  assert.equal((await reducedRevenue.json()).code, "REFUND_EXCEEDS_REVENUE");
  assert.equal(db.writes, 0);
});

test("stale revision or expected value returns conflict without writing", async () => {
  for (const stale of [{ ...change, expectedRevision: 1 }, { ...change, expectedValue: 1300 }]) {
    const db = fakeDatabase();
    const response = await createOrdersHandler(config, db.fetch)(request(stale));
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.equal(result.state, "conflict");
    assert.equal(result.record.cost, 1320);
    assert.equal(db.writes, 0);
  }
});

test("same persisted request replays without a write, but request ID reuse cannot change payload", async () => {
  const db = fakeDatabase();
  const handler = createOrdersHandler(config, db.fetch);
  assert.equal((await handler(request(change))).status, 200);
  const replay = await handler(request(change));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
  const reuse = await handler(request({ ...change, newValue: 800 }));
  assert.equal(reuse.status, 409);
  assert.equal((await reuse.json()).code, "REQUEST_ID_REUSED");
  assert.equal(db.writes, 1);
});

test("concurrent matching requests perform only one mutation using revision CAS", async () => {
  const db = fakeDatabase();
  const handler = createOrdersHandler(config, db.fetch);
  const results = await Promise.all([handler(request(change)), handler(request(change))]);
  assert.deepEqual(results.map((response) => response.status), [200, 200]);
  assert.equal(db.writes, 1);
  assert.equal(db.rows[0].revision, 1);
});

test("concurrent different changes cannot overwrite each other", async () => {
  const db = fakeDatabase();
  const handler = createOrdersHandler(config, db.fetch);
  const results = await Promise.all([
    handler(request(change)), handler(request({ ...change, newValue: 800, requestId: secondRequestId })),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  assert.equal(db.writes, 1);
  assert.equal(db.rows[0].cost, 900);
});

test("a later edit makes an old request conflict rather than applying it again", async () => {
  const db = fakeDatabase();
  const handler = createOrdersHandler(config, db.fetch);
  await handler(request(change));
  assert.equal((await handler(request({ ...change, requestId: secondRequestId, expectedRevision: 1, expectedValue: 900, newValue: 800 }))).status, 200);
  assert.equal((await handler(request(change))).status, 409);
  assert.equal(db.writes, 2);
  assert.equal(db.rows[0].cost, 800);
});

test("failed or conflicting independent readback never claims the correction was verified", async () => {
  for (const options of [{ failReadAfterWrite: true }, { malformedPatchResponse: true },
    { afterWrite: (row) => { row.cost = 700; row.revision = 2; row.last_request_id = secondRequestId; } }]) {
    const db = fakeDatabase(options);
    const response = await createOrdersHandler(config, db.fetch)(request(change));
    const result = await response.json();
    assert.equal(response.status, 202);
    assert.equal(result.state, "unknown");
    assert.equal(db.writes, 1);
    assert.equal(db.calls.filter((call) => call.init.method === "PATCH").length, 1);
    assertSanitized(result);
  }
});

test("database errors and timeouts are sanitized and never cause an automatic retry", async () => {
  for (const [options, status, state] of [[{ patchStatus: 503 }, 202, "unknown"],
    [{ patchStatus: 403 }, 502, "rejected"], [{ patchStatus: 409 }, 409, "conflict"],
    [{ patchThrows: true }, 202, "unknown"]]) {
    const db = fakeDatabase(options);
    const response = await createOrdersHandler(config, db.fetch)(request(change));
    const result = await response.json();
    assert.equal(response.status, status);
    assert.equal(result.state, state);
    assert.equal(db.calls.filter((call) => call.init.method === "PATCH").length, 1);
    assertSanitized(result);
  }
});

test("incomplete, duplicate, unknown or invalid database rows cannot masquerade as a verified dataset", async () => {
  for (const edit of [(rows) => rows.pop(), (rows) => { rows[1] = rows[0]; },
    (rows) => { rows[0].record_id = "NS-9999"; }, (rows) => { rows[0].revenue = "1200"; },
    (rows) => { rows[0].refund = 9999; }]) {
    const db = fakeDatabase(); edit(db.rows);
    const response = await createOrdersHandler(config, db.fetch)(request());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).state, "unknown");
  }
});
