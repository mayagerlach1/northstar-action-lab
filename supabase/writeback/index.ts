/**
 * Narrow server-to-server writeback for ONE synthetic record.
 * Deploy as ie-action-lab-writeback with verify_jwt=false ONLY with this custom
 * authentication intact. The service-role key stays inside the Edge runtime.
 * Replace this SHA-256 placeholder at deployment with the hash of a strong,
 * randomly generated server-only LAB_ACCESS_KEY. Never commit the plaintext key.
 */
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

const EXPECTED_ACCESS_KEY_SHA256 = "REPLACE_WITH_64_HEX_SHA256_OF_SERVER_LAB_ACCESS_KEY";
const RECORD_ID = "NS-1041";
const TABLE = "ie_action_lab_reviews";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 1024;
type Config = { expectedHash: string; supabaseUrl: string; serviceRoleKey: string };
type ReviewRow = {
  record_id: string;
  synthetic: boolean;
  review_status: "pending" | "reviewed";
  request_id: string | null;
  reviewed_at: string | null;
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function authorized(req: Request, expectedHash: string) {
  const key = req.headers.get("x-lab-access-key") || "";
  if (key.length < 32 || key.length > 256) return false;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const actual = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return difference === 0;
}

async function boundedBody(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BYTES || !req.body) throw new Error("invalid body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error("body too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function safeRecord(row: ReviewRow) {
  if (row?.record_id !== RECORD_ID || row.synthetic !== true || !["pending", "reviewed"].includes(row.review_status)) throw new Error("unexpected record");
  return {
    recordId: RECORD_ID,
    reviewStatus: row.review_status,
    reviewedAt: row.reviewed_at,
    requestId: row.request_id,
    synthetic: true,
  };
}

export function createWritebackHandler(config: Config, fetchImpl: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    if (!/^[0-9a-f]{64}$/.test(config.expectedHash) || !config.serviceRoleKey || !config.supabaseUrl.startsWith("https://")) {
      return respond(503, { state: "unavailable", code: "WRITEBACK_NOT_CONFIGURED" });
    }
    if (!(await authorized(req, config.expectedHash))) return respond(401, { state: "rejected", code: "UNAUTHORIZED" });
    if (!["GET", "POST"].includes(req.method)) return respond(405, { state: "rejected", code: "METHOD_NOT_ALLOWED" });
    const endpoint = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/${TABLE}`;
    const headers = { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`, "Content-Type": "application/json", "Cache-Control": "no-cache" };
    const read = async () => {
      const response = await fetchImpl(`${endpoint}?record_id=eq.${RECORD_ID}&select=record_id,synthetic,review_status,request_id,reviewed_at`, {
        headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("read failed");
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length !== 1) throw new Error("fixture missing");
      return safeRecord(rows[0]);
    };
    if (req.method === "GET") {
      try { return respond(200, { state: "read", record: await read() }); }
      catch { return respond(503, { state: "unavailable", code: "READBACK_UNAVAILABLE" }); }
    }
    let body: { requestId: string; confirmed: boolean };
    try {
      if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new Error("JSON required");
      body = await boundedBody(req);
      if (!body || Array.isArray(body) || Object.keys(body).some((key) => !["requestId", "confirmed"].includes(key)) || body.confirmed !== true || typeof body.requestId !== "string" || !UUID.test(body.requestId)) throw new Error("invalid input");
    } catch { return respond(400, { state: "rejected", code: "CONFIRMED_SYNTHETIC_REQUEST_REQUIRED" }); }
    try {
      const current = await read();
      if (current.reviewStatus === "reviewed" && current.requestId === body.requestId.toLowerCase()) {
        return respond(200, { state: "persisted", replay: true, record: current });
      }
      const response = await fetchImpl(`${endpoint}?on_conflict=record_id`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ record_id: RECORD_ID, synthetic: true, review_status: "reviewed", request_id: body.requestId.toLowerCase(), reviewed_at: new Date().toISOString() }),
        redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return respond(502, { state: response.status >= 500 ? "unknown" : "rejected", code: "WRITEBACK_NOT_CONFIRMED" });
      // Read again through the database API; a local status change is not proof.
      const record = await read();
      if (record.reviewStatus !== "reviewed" || record.requestId !== body.requestId.toLowerCase()) return respond(202, { state: "unknown", code: "VERIFY_SAVED_REQUEST" });
      return respond(200, { state: "persisted", replay: false, record });
    } catch { return respond(202, { state: "unknown", code: "VERIFY_BEFORE_RETRY" }); }
  };
}

if (typeof Deno !== "undefined") {
  Deno.serve(createWritebackHandler({
    expectedHash: EXPECTED_ACCESS_KEY_SHA256,
    supabaseUrl: Deno.env.get("SUPABASE_URL") || "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  }));
}
