/** Fixed synthetic-record write-back through a narrowly authorized Supabase function. */
export function supabaseConfigFromEnv(env = process.env) {
  return { url: env.LAB_SUPABASE_URL, accessKey: env.LAB_ACCESS_KEY };
}
export function validateSupabaseConfig(config) {
  return Boolean(config && typeof config.url === "string" && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.url) && typeof config.accessKey === "string" && config.accessKey.length >= 24);
}
function normalized(data) {
  if (!data || !["read", "persisted"].includes(data.state)) return { state: "unknown" };
  const record = data?.record;
  if (!record) return { state: "not_found" };
  if (record.recordId === "NS-1041" && record.reviewStatus === "pending" && record.synthetic === true) return { state: "not_found" };
  const requestId = record.requestId;
  const updatedAt = record.reviewedAt;
  if (record.recordId !== "NS-1041" || record.reviewStatus !== "reviewed" || record.synthetic !== true ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || "") || !Number.isFinite(Date.parse(updatedAt))) return { state: "unknown" };
  return { state: "verified", id: record.recordId, recordId: record.recordId, status: "reviewed", requestId, updatedAt };
}
async function request(config, method, body, options = {}) {
  if (!validateSupabaseConfig(config)) return { state: "not_configured" };
  try {
    const response = await (options.fetchImpl || fetch)(`${config.url}/functions/v1/ie-action-lab-writeback`, {
      method, headers: { "x-lab-access-key": config.accessKey, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000), redirect: "error", cache: "no-store",
    });
    if (!response.ok) return { state: response.status >= 400 && response.status < 500 && response.status !== 408 && method === "POST" ? "rejected" : "unknown", httpStatus: response.status };
    return normalized(await response.json());
  } catch { return { state: "unknown" }; }
}
export async function readSupabaseReview(config, options) { return request(config, "GET", undefined, options); }
export async function writeSupabaseReview(config, { requestId, confirmed }, options) {
  if (confirmed !== true || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || "")) return { state: "rejected" };
  const written = await request(config, "POST", { requestId, confirmed: true }, options);
  if (written.state !== "verified") return written;
  const read = await readSupabaseReview(config, options);
  return read.state === "verified" && read.requestId === requestId ? read : { state: "unknown" };
}
