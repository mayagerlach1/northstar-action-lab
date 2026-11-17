const MAX_BODY = 16 * 1024;

async function readJson(req) {
  if (Number(req.headers["content-length"] || 0) > MAX_BODY) throw Object.assign(new Error(), { status: 413 });
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw Object.assign(new Error(), { status: 415 });
  // Vercel may already have parsed JSON; the local Node server provides a stream.
  if (req.body !== undefined) {
    const raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > MAX_BODY) throw Object.assign(new Error(), { status: 413 });
    return JSON.parse(raw);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function jsonRoute(operation) {
  return async function handler(req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.statusCode = 405;
      res.end(JSON.stringify({ state: "invalid", code: "METHOD_NOT_ALLOWED" }));
      return;
    }
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        res.statusCode = 403;
        res.end(JSON.stringify({ state: "invalid", code: "ORIGIN_NOT_ALLOWED" }));
        return;
      }
      const body = await readJson(req);
      const outcome = await operation(body);
      res.statusCode = outcome.status;
      if (outcome.body.retryAfter) res.setHeader("Retry-After", String(outcome.body.retryAfter));
      res.end(JSON.stringify(outcome.body));
    } catch (error) {
      res.statusCode = [413, 415].includes(error.status) ? error.status : 400;
      res.end(JSON.stringify({ state: "invalid", code: res.statusCode === 413 ? "BODY_TOO_LARGE" : "INVALID_JSON_REQUEST", message: "Send a JSON request smaller than 16 KB with the expected fields." }));
    }
  };
}
