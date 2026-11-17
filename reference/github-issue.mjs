/**
 * Server-side transport example for the Session 3 lab (Node 22+).
 * This is NOT a public route: authentication, authorization, persistence and
 * duplicate protection belong in the calling application. See README.md.
 */
if (typeof window !== "undefined") {
  throw new Error("The GitHub action helper must only run on the server.");
}

const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const validId = (value) => typeof value === "string" && idPattern.test(value);

export function validateDestination(config) {
  return Boolean(
    config &&
    typeof config.owner === "string" &&
    typeof config.repo === "string" &&
    ownerPattern.test(config.owner ?? "") &&
    repoPattern.test(config.repo ?? "") &&
    typeof config.token === "string" &&
    config.token.trim().length > 0,
  );
}

export function actionMarker(requestId) {
  if (!validId(requestId)) throw new Error("Invalid request ID.");
  return `<!-- ie-lab-action:${requestId} -->`;
}

function issuePayload(action) {
  if (
    !action ||
    typeof action.title !== "string" ||
    !action.title.trim() ||
    action.title.length > 256 ||
    typeof action.body !== "string" ||
    !action.body.trim() ||
    action.body.length > 16000 ||
    !validId(action.recordId) ||
    !validId(action.requestId)
  ) {
    return null;
  }
  return {
    title: action.title.trim(),
    body: `${action.body.trim()}\n\n---\nSource record: \`${action.recordId}\`\nAction request: \`${action.requestId}\`\n${actionMarker(action.requestId)}`,
  };
}

/** No mutation is retried automatically, including a timeout or HTTP 5xx. */
export async function createGithubIssue(config, action, options = {}) {
  const payload = issuePayload(action);
  const context = {
    requestId: validId(action?.requestId) ? action.requestId : null,
    recordId: validId(action?.recordId) ? action.recordId : null,
  };
  if (!validateDestination(config) || !payload) {
    return {
      ...context,
      state: "invalid",
      code: "INVALID_ACTION_OR_CONFIGURATION",
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    return { ...context, state: "invalid", code: "INVALID_TIMEOUT" };
  }
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${config.owner}/${config.repo}/issues`,
      {
        method: "POST",
        headers: githubHeaders(config.token),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      },
    );
  } catch {
    // The server may have created the issue before the connection was lost.
    return {
      ...context,
      state: "unknown",
      code: "CHECK_DESTINATION_BEFORE_RETRY",
    };
  }
  if (response.status !== 201) {
    const rejected =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408;
    return {
      ...context,
      state: rejected ? "rejected" : "unknown",
      code: rejected
        ? "GITHUB_REJECTED_REQUEST"
        : "CHECK_DESTINATION_BEFORE_RETRY",
      httpStatus: response.status,
    };
  }
  try {
    const issue = await response.json();
    const url = new URL(issue.html_url);
    const expectedPath = `/${config.owner}/${config.repo}/issues/${issue.number}`;
    if (
      !Number.isSafeInteger(issue.id) ||
      !Number.isSafeInteger(issue.number) ||
      issue.number < 1 ||
      url.origin !== "https://github.com" ||
      url.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
      url.search ||
      url.hash
    )
      throw new Error("Unexpected issue response.");
    return {
      ...context,
      state: "created",
      issueId: issue.id,
      issueNumber: issue.number,
      issueUrl: url.href,
      httpStatus: response.status,
    };
  } catch {
    return {
      ...context,
      state: "unknown",
      code: "CHECK_DESTINATION_BEFORE_RETRY",
      httpStatus: response.status,
    };
  }
}

/** Use only on the server. Do not log the returned headers. */
export function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ie-session-3-action-preflight",
  };
}
