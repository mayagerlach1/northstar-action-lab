import { createPreflightService } from "../server-lib/action-preflight.mjs";
export const maxDuration = 60;
const service = createPreflightService();
export default async function handler(req, res) {
  const reply = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return reply(200, await service.statusWithReadback(req.headers.authorization));
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return reply(405, { state: "rejected", message: "Use GET or POST." }); }
  try {
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return reply(403, { state: "rejected", message: "Origin not allowed." });
    if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return reply(415, { state: "rejected", message: "Use application/json." });
    let raw;
    if (req.body !== undefined) raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    else {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return reply(413, { state: "rejected", message: "Request is too large." }); chunks.push(chunk); }
      raw = Buffer.concat(chunks).toString("utf8");
    }
    if (Buffer.byteLength(raw) > 4096) return reply(413, { state: "rejected", message: "Request is too large." });
    const result = await service.submit(JSON.parse(raw), req.headers.authorization);
    return reply(result.status, result.body);
  } catch { return reply(400, { state: "rejected", message: "Invalid request." }); }
}
