import { randomUUID } from "node:crypto";
import dataset from "../public/data.json" with { type: "json" };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE = "https://ntfy.sh";
const validUuid = (value) => typeof value === "string" && UUID.test(value);
const validCaptureId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const topic = (id) => `ie-action-lab-${id}`;
const viewer = (id) => `${BASE}/${topic(id)}`;
const result = (status, body) => ({ status, body: { provider: "ntfy", ...body } });
const invalid = (code = "INVALID_INPUT") => result(400, { state: "invalid", code, message: "Check the receiver, request ID, source order and review fields." });
const allowedKeys = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
const reviewText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function canonicalRecord(id) {
  const order = dataset.orders.find((entry) => entry.id === id);
  if (!order) return null;
  const netRevenue = order.revenue - order.refund;
  const profit = netRevenue - order.cost;
  return {
    id: order.id, product: order.product, category: order.category,
    region: order.region, channel: order.channel, owner: order.owner,
    status: order.status, revenue: order.revenue, cost: order.cost, refund: order.refund,
    netRevenue, profit,
    marginRate: netRevenue > 0 ? profit / netRevenue : null,
    refundRate: order.revenue > 0 ? order.refund / order.revenue : null,
    lateDelivery: (order.deliveredDate || dataset.meta.asOf) > order.promisedDate,
  };
}

function parsedCapture(row, receiverId) {
  if (!row || row.event !== "message" || row.topic !== topic(receiverId) || !validCaptureId(row.id) || typeof row.message !== "string" || Buffer.byteLength(row.message) > 4096) return null;
  try {
    const event = JSON.parse(row.message);
    if (!validUuid(event.requestId) || event.eventType !== "ie-lab.review-request" || event.schemaVersion !== 1 || event.synthetic !== true) return null;
    const record = canonicalRecord(event.orderId);
    if (!record || !event.record || !event.review || event.snapshotAsOf !== dataset.meta.asOf) return null;
    if (!Object.entries(record).every(([key, value]) => event.record[key] === value)) return null;
    if (!reviewText(event.review.title, 140) || !reviewText(event.review.reason, 600)) return null;
    return { row, event };
  } catch { return null; }
}

export function createNtfyLab({ fetchImpl = fetch, timeoutMs = 10000, now = () => new Date(), newId = randomUUID } = {}) {
  async function request(path, options = {}) {
    return fetchImpl(`${BASE}${path}`, { ...options, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  }
  async function captured(receiverId, requestId) {
    try {
      // Give each read a fresh URL as well as no-cache headers: intermediary
      // caches can otherwise reuse the empty pre-send poll during verification.
      const response = await request(`/${topic(receiverId)}/json?poll=1&since=all&_=${randomUUID()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
      });
      if (!response.ok) return { ok: false, httpStatus: response.status };
      // A topic with no messages returns an empty successful poll, not a fabricated receipt.
      const text = await response.text();
      if (Buffer.byteLength(text) > 1024 * 1024) return { ok: false };
      const rows = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
      const events = rows.map((row) => parsedCapture(row, receiverId)).filter(Boolean);
      const matches = events.filter((entry) => entry.event.requestId === requestId);
      return { ok: true, match: matches[0], matches, matchCount: matches.length, uniqueCount: new Set(events.map((entry) => entry.event.requestId)).size };
    } catch { return { ok: false }; }
  }
  function receipt(receiverId, requestId, match, captureCount = 1) {
    return result(200, {
      state: "received", requestId, orderId: match.event.orderId,
      captureId: match.row.id, captureCount, viewerUrl: viewer(receiverId),
      receivedAt: Number.isFinite(match.row.time) ? new Date(match.row.time * 1000).toISOString() : null,
      ...(captureCount > 1 ? { warning: "DUPLICATE_CAPTURES", duplicateCount: captureCount - 1 } : {}),
      message: captureCount > 1 ? `The receiver captured this request ${captureCount} times. Delivery is verified, but duplicate delivery occurred; inspect the receiver and do not resend.` : "The external receiver captured this request and its synthetic source facts.",
    });
  }
  function unknown(receiverId, requestId, httpStatus) {
    return result(202, {
      state: "unknown", requestId, viewerUrl: viewer(receiverId),
      ...(httpStatus ? { httpStatus } : {}),
      code: "VERIFY_BEFORE_RETRY",
      message: "Receipt is not confirmed. Verify again or inspect the receiver before sending another request.",
    });
  }
  return {
    async receiver(body) {
      if (!allowedKeys(body, [])) return invalid();
      const receiverId = newId().toLowerCase();
      return result(201, {
        state: "ready", receiverId, viewerUrl: viewer(receiverId),
        expiresInSeconds: 43200,
        message: "Random public practice topic ready. Only fictional data: anyone with its URL can read it. Message cache is temporary, observed up to 12 hours; this is not a private database.",
      });
    },
    async verify(body) {
      if (!allowedKeys(body, ["receiverId", "requestId"]) || !validUuid(body.receiverId) || !validUuid(body.requestId)) return invalid();
      const receiverId = body.receiverId.toLowerCase();
      const requestId = body.requestId.toLowerCase();
      const found = await captured(receiverId, requestId);
      return found.ok && found.match ? receipt(receiverId, requestId, found.match, found.matchCount) : unknown(receiverId, requestId, found.httpStatus);
    },
    async send(body) {
      if (!allowedKeys(body, ["receiverId", "requestId", "orderId", "title", "reason"]) || !validUuid(body.receiverId) || !validUuid(body.requestId) || typeof body.orderId !== "string" || !reviewText(body.title, 140) || !reviewText(body.reason, 600)) return invalid();
      const record = canonicalRecord(body.orderId);
      if (!record) return invalid("UNKNOWN_SYNTHETIC_ORDER");
      const receiverId = body.receiverId.toLowerCase();
      const requestId = body.requestId.toLowerCase();
      const title = body.title.trim(), reason = body.reason.trim();
      const event = {
        eventType: "ie-lab.review-request", schemaVersion: 1, synthetic: true,
        requestId, orderId: body.orderId, createdAt: now().toISOString(),
        snapshotAsOf: dataset.meta.asOf, review: { title, reason }, record,
      };
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized) > 4096) return invalid("EVENT_TOO_LARGE");
      // Read before write prevents a known repeat, but is not a distributed lock.
      const found = await captured(receiverId, requestId);
      if (!found.ok) return unknown(receiverId, requestId, found.httpStatus);
      if (found.match) {
        if (found.matches.some((match) => match.event.orderId !== body.orderId || match.event.review.title !== title || match.event.review.reason !== reason)) {
          return result(409, { state: "rejected", code: "REQUEST_ID_REUSED", requestId, message: "This request ID already belongs to different content. Inspect its receipt before starting a new intentional action." });
        }
        return receipt(receiverId, requestId, found.match, found.matchCount);
      }
      if (found.uniqueCount >= 2) {
        return result(429, { state: "rejected", code: "PRACTICE_LIMIT_REACHED", requestId, message: "This topic already has two captured practice actions. Use those receipts and local tests for the remaining exercises." });
      }
      try {
        const response = await request(`/${topic(receiverId)}`, {
          method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8", Title: "IE lab synthetic review request" }, body: serialized,
        });
        if (response.ok) return result(202, {
          state: "accepted", requestId, orderId: body.orderId, httpStatus: response.status, viewerUrl: viewer(receiverId),
          message: "The receiver returned an HTTP acceptance. Verify its captured message before calling it received.",
        });
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          return result(response.status === 429 ? 429 : 502, { state: "rejected", code: "RECEIVER_REJECTED", requestId, orderId: body.orderId, httpStatus: response.status, viewerUrl: viewer(receiverId), message: "The receiver rejected this request. Check its status and limits before deciding whether to start a new action." });
        }
        return unknown(receiverId, requestId, response.status);
      } catch { return unknown(receiverId, requestId); }
    },
  };
}
