/**
 * Correct real numeric values for 24 synthetic orders. No review-status toggles.
 * Deploy as ie-action-lab-orders with verify_jwt=false ONLY with this custom
 * authentication intact. Replace the hash placeholder at deployment, never with
 * a plaintext key. Supabase service credentials remain inside the Edge runtime.
 * PATCH compares both revision and previous value atomically. No write retries.
 */
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

const EXPECTED_ACCESS_KEY_SHA256 = "REPLACE_WITH_64_HEX_SHA256_OF_SERVER_LAB_ACCESS_KEY";
const TABLE = "ie_action_lab_order_values";
export const ORDER_IDS = Object.freeze(Array.from({ length: 24 }, (_, index) => `NS-${1041 + index}`));
const KNOWN_IDS = new Set(ORDER_IDS);
const FIELDS = new Set(["revenue", "cost", "refund"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_VALUE = 1_000_000_000;
const MAX_BODY_BYTES = 4096;
const READ_COLUMNS = "record_id,revenue,cost,refund,revision,updated_at,update_reason,last_request_id,last_change_field,last_previous_value,last_new_value,last_expected_revision";
type Field = "revenue" | "cost" | "refund";
type Config = { expectedHash: string; supabaseUrl: string; serviceRoleKey: string };
type Row = {
  record_id: string; revenue: number; cost: number; refund: number; revision: number;
  updated_at: string; update_reason: string | null; last_request_id: string | null;
  last_change_field: Field | null; last_previous_value: number | null;
  last_new_value: number | null; last_expected_revision: number | null;
};
type Change = {
  recordId: string; field: Field; newValue: number; expectedValue: number;
  expectedRevision: number; reason: string; requestId: string; confirmed: true;
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function validConfig(config: Config) {
  return Boolean(config && /^[0-9a-f]{64}$/.test(config.expectedHash) &&
    typeof config.serviceRoleKey === "string" && config.serviceRoleKey.length > 0 &&
    /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.supabaseUrl));
}

async function authorized(req: Request, expectedHash: string) {
  const key = req.headers.get("x-lab-access-key") || "";
  if (key.length < 32 || key.length > 256) return false;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const actual = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  return difference === 0;
}

function money(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_VALUE;
}

function validRow(value: unknown): value is Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Row;
  return typeof row.record_id === "string" && KNOWN_IDS.has(row.record_id) &&
    money(row.revenue) && money(row.cost) && money(row.refund) && row.refund <= row.revenue &&
    Number.isSafeInteger(row.revision) && row.revision >= 0 &&
    typeof row.updated_at === "string" && Number.isFinite(Date.parse(row.updated_at));
}

function publicRecord(row: Row) {
  return {
    recordId: row.record_id, revenue: row.revenue, cost: row.cost, refund: row.refund,
    revision: row.revision, updatedAt: row.updated_at,
  };
}

async function parseChange(req: Request): Promise<Change | null> {
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json") || !req.body ||
    Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const allowed = ["recordId", "field", "newValue", "expectedValue", "expectedRevision", "reason", "requestId", "confirmed"];
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      typeof input.recordId !== "string" || !KNOWN_IDS.has(input.recordId) ||
      typeof input.field !== "string" || !FIELDS.has(input.field) ||
      !money(input.newValue) || !money(input.expectedValue) || input.newValue === input.expectedValue ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      typeof input.reason !== "string" || input.reason.trim().length < 5 || input.reason.trim().length > 600 || input.reason.includes("\0") ||
      typeof input.requestId !== "string" || !UUID.test(input.requestId) || input.confirmed !== true) return null;
    return { ...input, requestId: input.requestId.toLowerCase(), reason: input.reason.trim() } as Change;
  } catch { return null; }
}

function matchesStoredRequest(row: Row, change: Change) {
  return row.last_request_id === change.requestId && row.last_change_field === change.field &&
    row.last_previous_value === change.expectedValue && row.last_new_value === change.newValue &&
    row.last_expected_revision === change.expectedRevision && row.update_reason === change.reason &&
    row.revision === change.expectedRevision + 1 && row[change.field] === change.newValue;
}

function verified(row: Row, change: Change, replay = false) {
  return respond(200, {
    state: "verified", record: publicRecord(row),
    change: { field: change.field, oldValue: change.expectedValue, newValue: change.newValue },
    requestId: change.requestId, replay,
  });
}

export function createOrdersHandler(config: Config, fetchImpl: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    if (!validConfig(config)) return respond(503, { state: "not_configured", code: "ORDERS_NOT_CONFIGURED" });
    if (!(await authorized(req, config.expectedHash))) return respond(401, { state: "rejected", code: "UNAUTHORIZED" });
    if (!["GET", "POST"].includes(req.method)) return respond(405, { state: "rejected", code: "METHOD_NOT_ALLOWED" });
    const endpoint = `${config.supabaseUrl}/rest/v1/${TABLE}`;
    const headers = {
      apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json", "Cache-Control": "no-cache",
    };
    const read = async (recordId?: string): Promise<Row[]> => {
      const query = new URLSearchParams({ select: READ_COLUMNS, order: "record_id.asc" });
      if (recordId) query.set("record_id", `eq.${recordId}`);
      const response = await fetchImpl(`${endpoint}?${query}`, {
        method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("read unavailable");
      const rows = await response.json();
      const expectedCount = recordId ? 1 : ORDER_IDS.length;
      if (!Array.isArray(rows) || rows.length !== expectedCount || !rows.every(validRow) ||
        new Set(rows.map((row: Row) => row.record_id)).size !== expectedCount ||
        (recordId && rows[0].record_id !== recordId)) throw new Error("unexpected source data");
      return rows as Row[];
    };
    if (req.method === "GET") {
      try { return respond(200, { state: "verified", records: (await read()).map(publicRecord) }); }
      catch { return respond(503, { state: "unknown", code: "READBACK_UNAVAILABLE" }); }
    }
    const change = await parseChange(req);
    if (!change) return respond(400, { state: "rejected", code: "VALID_CONFIRMED_NUMERIC_CHANGE_REQUIRED" });
    let current: Row;
    try { [current] = await read(change.recordId); }
    catch { return respond(503, { state: "unknown", code: "READBACK_UNAVAILABLE", requestId: change.requestId }); }
    if (current.last_request_id === change.requestId) {
      return matchesStoredRequest(current, change) ? verified(current, change, true)
        : respond(409, { state: "conflict", code: "REQUEST_ID_REUSED", requestId: change.requestId });
    }
    if (current.revision !== change.expectedRevision || current[change.field] !== change.expectedValue) {
      return respond(409, { state: "conflict", code: "RECORD_CHANGED", record: publicRecord(current), requestId: change.requestId });
    }
    const nextRevenue = change.field === "revenue" ? change.newValue : current.revenue;
    const nextRefund = change.field === "refund" ? change.newValue : current.refund;
    if (nextRefund > nextRevenue) return respond(400, { state: "rejected", code: "REFUND_EXCEEDS_REVENUE", requestId: change.requestId });
    const query = new URLSearchParams({
      record_id: `eq.${change.recordId}`, revision: `eq.${change.expectedRevision}`,
      [change.field]: `eq.${change.expectedValue}`, select: "record_id,revision",
    });
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}?${query}`, {
        method: "PATCH", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          [change.field]: change.newValue, revision: change.expectedRevision + 1,
          updated_at: new Date().toISOString(), update_reason: change.reason,
          last_request_id: change.requestId, last_change_field: change.field,
          last_previous_value: change.expectedValue, last_new_value: change.newValue,
          last_expected_revision: change.expectedRevision,
        }), redirect: "error", signal: AbortSignal.timeout(10000),
      });
    } catch {
      return respond(202, { state: "unknown", code: "VERIFY_BEFORE_RETRY", requestId: change.requestId });
    }
    if (!response.ok) {
      if (response.status === 409) return respond(409, { state: "conflict", code: "WRITE_CONFLICT", requestId: change.requestId });
      const ambiguous = response.status >= 500 || response.status === 408;
      return respond(ambiguous ? 202 : 502, {
        state: ambiguous ? "unknown" : "rejected", code: ambiguous ? "VERIFY_BEFORE_RETRY" : "WRITE_REJECTED",
        requestId: change.requestId,
      });
    }
    let updatedRows: unknown;
    try { updatedRows = await response.json(); }
    catch { return respond(202, { state: "unknown", code: "VERIFY_BEFORE_RETRY", requestId: change.requestId }); }
    if (!Array.isArray(updatedRows) || updatedRows.length > 1 ||
      (updatedRows.length === 1 && (updatedRows[0]?.record_id !== change.recordId || updatedRows[0]?.revision !== change.expectedRevision + 1))) {
      return respond(202, { state: "unknown", code: "VERIFY_BEFORE_RETRY", requestId: change.requestId });
    }
    // Independent database GET: PATCH representation alone is never proof.
    let saved: Row;
    try { [saved] = await read(change.recordId); }
    catch { return respond(202, { state: "unknown", code: "VERIFY_BEFORE_RETRY", requestId: change.requestId }); }
    if (matchesStoredRequest(saved, change)) return verified(saved, change, updatedRows.length === 0);
    if (updatedRows.length === 0) {
      return respond(409, { state: "conflict", code: "RECORD_CHANGED", record: publicRecord(saved), requestId: change.requestId });
    }
    return respond(202, { state: "unknown", code: "VERIFY_BEFORE_RETRY", requestId: change.requestId });
  };
}

if (typeof Deno !== "undefined") {
  Deno.serve(createOrdersHandler({
    expectedHash: EXPECTED_ACCESS_KEY_SHA256,
    supabaseUrl: Deno.env.get("SUPABASE_URL") || "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  }));
}
