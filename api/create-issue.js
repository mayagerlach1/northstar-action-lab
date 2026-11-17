/**
 * Intentionally disabled teaching scaffold.
 * Implement the complete contract in reference/INTEGRATION.md before enabling.
 * Do not add a GitHub token to this route without authentication, record-level
 * authorization, confirmation verification, persistence and duplicate control.
 */
export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.statusCode = 405;
    res.end(JSON.stringify({ state: "disabled", code: "METHOD_NOT_ALLOWED" }));
    return;
  }
  res.statusCode = 501;
  res.end(JSON.stringify({
    state: "disabled",
    code: "PRACTICE_MODE_ONLY",
    message: "This starter does not send external actions. Complete the server integration contract before enabling this endpoint.",
  }));
}
