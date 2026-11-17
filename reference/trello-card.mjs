/**
 * Node 22+ server-only Trello transport. No account, token or paid plan is created.
 * The caller owns authentication, authorization and persistent duplicate handling.
 * Trello does not provide an idempotency guarantee for this create-card operation.
 */
if (typeof window !== "undefined") {
  throw new Error("The Trello helper must only run on the server.");
}

const objectId = /^[a-f0-9]{24}$/i;
const actionId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const credential = /^[A-Za-z0-9_-]{16,512}$/;

/** Read only from trusted server configuration, never browser request fields. */
export function trelloConfigFromEnv(env = process.env) {
  return {
    apiKey: env.TRELLO_API_KEY,
    token: env.TRELLO_TOKEN,
    listId: env.TRELLO_LIST_ID,
  };
}

export function validateTrelloDestination(config) {
  return Boolean(
    config &&
      typeof config.apiKey === "string" && credential.test(config.apiKey) &&
      typeof config.token === "string" && credential.test(config.token) &&
      typeof config.listId === "string" && objectId.test(config.listId),
  );
}

export function trelloCardPayload(action) {
  if (
    !action || typeof action.requestId !== "string" || !actionId.test(action.requestId) ||
    typeof action.recordId !== "string" || !actionId.test(action.recordId) ||
    typeof action.title !== "string" || !action.title.trim() ||
    action.title.length > 256 || /[\r\n\x00]/.test(action.title) ||
    typeof action.body !== "string" || !action.body.trim() ||
    action.body.length > 12000 || action.body.includes("\0")
  ) return null;
  return {
    name: action.title.trim(),
    desc: `${action.body.trim()}\n\n---\nSource record: ${action.recordId}\nAction request: ${action.requestId}\n[ie-lab-action:${action.requestId}]`,
  };
}

function context(action) {
  return {
    requestId: typeof action?.requestId === "string" && actionId.test(action.requestId) ? action.requestId : null,
    recordId: typeof action?.recordId === "string" && actionId.test(action.recordId) ? action.recordId : null,
  };
}

function timeout(options) {
  const value = options.timeoutMs ?? 10000;
  return Number.isInteger(value) && value > 0 && value <= 60000 ? value : null;
}

function headers(config) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `OAuth oauth_consumer_key="${config.apiKey}", oauth_token="${config.token}"`,
  };
}

function cardUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://trello.com" ||
      !/^\/c\/[A-Za-z0-9]+(?:\/[^?#]*)?$/.test(url.pathname) ||
      url.search || url.hash || url.username || url.password
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Exactly one POST attempt. No automatic retry on timeout, 5xx or bad responses. */
export async function createTrelloCard(config, action, options = {}) {
  const linkage = context(action);
  const payload = trelloCardPayload(action);
  const timeoutMs = timeout(options);
  if (!validateTrelloDestination(config) || !payload || !timeoutMs) {
    return { ...linkage, state: "invalid", code: "INVALID_ACTION_OR_CONFIGURATION" };
  }
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)("https://api.trello.com/1/cards", {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ ...payload, idList: config.listId }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return { ...linkage, state: "unknown", code: "CHECK_TRELLO_BEFORE_RETRY" };
  }
  if (response.status !== 200) {
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
    return {
      ...linkage, state: rejected ? "rejected" : "unknown",
      code: rejected ? "TRELLO_REJECTED_REQUEST" : "CHECK_TRELLO_BEFORE_RETRY",
      httpStatus: response.status,
    };
  }
  try {
    const card = await response.json();
    const url = cardUrl(card.url ?? card.shortUrl);
    if (typeof card.id !== "string" || !objectId.test(card.id) || !url || card.idList !== config.listId ||
      card.name !== payload.name || card.desc !== payload.desc) throw new Error("Unexpected response");
    return { ...linkage, state: "created", cardId: card.id, cardUrl: url, httpStatus: 200 };
  } catch {
    return { ...linkage, state: "unknown", code: "CHECK_TRELLO_BEFORE_RETRY", httpStatus: 200 };
  }
}

/** Independent GET and exact comparison. The result never includes credentials/body. */
export async function verifyTrelloCard(config, action, cardId, options = {}) {
  const linkage = context(action);
  const payload = trelloCardPayload(action);
  const timeoutMs = timeout(options);
  if (!validateTrelloDestination(config) || !payload || !timeoutMs ||
    typeof cardId !== "string" || !objectId.test(cardId)) {
    return { ...linkage, state: "invalid", code: "INVALID_ACTION_OR_CONFIGURATION" };
  }
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `https://api.trello.com/1/cards/${cardId}?fields=id,name,desc,idList,url`,
      { method: "GET", headers: headers(config), signal: AbortSignal.timeout(timeoutMs), redirect: "error" },
    );
  } catch {
    return { ...linkage, state: "unknown", code: "READBACK_UNAVAILABLE", cardId };
  }
  if (response.status !== 200) {
    return { ...linkage, state: "unknown", code: "READBACK_UNAVAILABLE", cardId, httpStatus: response.status };
  }
  try {
    const card = await response.json();
    const url = cardUrl(card.url ?? card.shortUrl);
    if (card.id !== cardId || card.idList !== config.listId ||
      card.name !== payload.name || card.desc !== payload.desc || !url) {
      return { ...linkage, state: "mismatch", code: "CARD_CONTENT_MISMATCH", cardId, httpStatus: 200 };
    }
    return {
      ...linkage, state: "verified", cardId, cardUrl: url, httpStatus: 200,
      matched: { id: true, list: true, title: true, body: true },
    };
  } catch {
    return { ...linkage, state: "unknown", code: "READBACK_UNAVAILABLE", cardId, httpStatus: 200 };
  }
}
