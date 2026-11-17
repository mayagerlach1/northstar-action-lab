/** Server-only transport for the isolated synthetic orders table. No write retries. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validAmount = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000000;
export function validateSupabaseOrdersConfig(config) {
  return Boolean(config && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.url || "") && typeof config.accessKey === "string" && config.accessKey.length >= 32 && config.accessKey.length <= 256);
}
function validRecord(row) {
  return row && /^NS-\d{4}$/.test(row.recordId || "") && [row.revenue, row.cost, row.refund].every(validAmount) && row.refund <= row.revenue && Number.isSafeInteger(row.revision) && row.revision >= 0 && (row.updatedAt === null || (typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt))));
}
function cleanRecord(row) {
  return Object.fromEntries(["recordId", "revenue", "cost", "refund", "revision", "updatedAt"].map(key => [key, row[key]]));
}
async function request(config, method, body, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (!validateSupabaseOrdersConfig(config)) return { state: "not_configured" };
  try {
    const response = await fetchImpl(`${config.url}/functions/v1/ie-action-lab-orders`, {
      method, headers: { "x-lab-access-key": config.accessKey, "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-cache" },
      ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 409) return { state: "conflict", code: "RECORD_CHANGED", httpStatus: 409 };
    if (!response.ok) return { state: method === "POST" && response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown", httpStatus: response.status };
    return { state: "response", data: await response.json() };
  } catch { return { state: "unknown" }; }
}
export async function readSupabaseOrders(config, options) {
  const result = await request(config, "GET", null, options);
  if (result.state !== "response") return result;
  const data = result.data;
  if (data?.state !== "verified" || !Array.isArray(data.records) || data.records.length > 24 || !data.records.every(validRecord) || new Set(data.records.map(row => row.recordId)).size !== data.records.length) return { state: "unknown", code: "INVALID_DATABASE_READ" };
  return { state: "verified", records: data.records.map(cleanRecord) };
}
export async function updateSupabaseOrder(config, change, options) {
  if (!change || !/^NS-\d{4}$/.test(change.recordId || "") || !["revenue", "cost", "refund"].includes(change.field) || !validAmount(change.newValue) || !validAmount(change.expectedValue) || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0 || typeof change.reason !== "string" || change.reason.trim().length < 5 || change.reason.length > 600 || !UUID.test(change.requestId || "") || change.confirmed !== true) return { state: "rejected", code: "INVALID_CHANGE" };
  const payload = Object.fromEntries(["recordId", "field", "newValue", "expectedValue", "expectedRevision", "reason", "requestId", "confirmed"].map(key => [key, change[key]]));
  const result = await request(config, "POST", payload, options);
  if (result.state !== "response") return result;
  const data = result.data;
  if (data?.state !== "verified" || data.requestId !== change.requestId || !validRecord(data.record) || data.record.recordId !== change.recordId || data.record[change.field] !== change.newValue || data.record.revision !== change.expectedRevision + 1) return { state: "unknown", code: "WRITE_RESPONSE_MISMATCH" };
  const read = await readSupabaseOrders(config, options);
  const row = read.records?.find(record => record.recordId === change.recordId);
  if (read.state !== "verified" || !row || row.revision !== data.record.revision || ["revenue", "cost", "refund"].some(field => row[field] !== data.record[field])) return { state: "unknown", code: "WRITE_READBACK_MISMATCH" };
  return { state: "verified", record: row, records: read.records, requestId: change.requestId, replay: data.replay === true, change: { field: change.field, oldValue: change.expectedValue, newValue: change.newValue }, verification: { persisted: true, independentRead: true, value: true, revision: true } };
}
