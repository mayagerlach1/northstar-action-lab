/* Independent instructor preflight. Provider credentials never enter the browser. */
"use strict";

const API = "/api/action-preflight";
const ATTEMPTS_KEY = "northstar-preflight:v1:attempts";
const ACTIONS = ["email", "supabase", "trello", "github"];
const LABELS = {
  trello: "Trello card",
  email: "Resend email",
  supabase: "Supabase review save",
  github: "GitHub pull request",
};
const CONFIRM_LABELS = {
  trello: "Create real card →",
  email: "Send real test email →",
  supabase: "Save reviewed to Supabase →",
  github: "Open real pull request →",
};
const STATE_LABELS = {
  verified: "Verified by read-back",
  accepted: "Accepted · not verified",
  unknown: "Outcome unknown",
  rejected: "Request rejected",
  not_configured: "Not configured",
};
const DRAFT = {
  title: "Review negative contribution · NS-1041",
  body: "Synthetic classroom test — no customer data.\n\nOrder: NS-1041 · Summit desk bundle\nRevenue: USD 1,200\nProduct cost: USD 1,320\nRefunds: USD 0\nContribution: USD -120 (-10%)\n\nPlease review the recorded price, introductory discount and freight allocation before recommending a correction. This is a review request, not a confirmed error.",
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const $ = (id) => document.getElementById(id);
const model = {
  providers: {},
  previews: {},
  authenticated: false,
  accessPhrase: "",
  authorizationConfigured: undefined,
  checking: false,
  sending: false,
  pending: null,
  attempts: new Map(),
};

function setText(id, value) {
  $(id).textContent = typeof value === "string" ? value : "";
}

function hasPreview(action) {
  const preview = model.previews[action];
  return Boolean(
    preview &&
    typeof preview.title === "string" &&
    preview.title.trim() &&
    typeof preview.body === "string" &&
    preview.body.trim() &&
    (action !== "github" ||
      (typeof preview.diff === "string" && preview.diff.trim())),
  );
}

function canReview(action) {
  return Boolean(
    hasPreview(action) &&
    !model.checking &&
    !model.sending &&
    !model.attempts.has(action),
  );
}

function updateButtons() {
  document.querySelectorAll(".review-action").forEach((button) => {
    button.disabled = !canReview(button.dataset.action);
  });
  $("check-services").disabled = model.checking || model.sending;
  $("read-saved-review").disabled =
    !model.authenticated ||
    model.providers.supabase?.configured !== true ||
    model.checking ||
    model.sending;
  $("confirm-send").disabled =
    !model.pending ||
    !$("confirm-consent").checked ||
    !canReview(model.pending.action);
}

function setBadge(action, text, state = "") {
  const badge = $(`${action}-state`);
  badge.textContent = text;
  badge.className = `state-badge${state ? ` state-${state}` : ""}`;
}

function renderConnections() {
  for (const action of ACTIONS) {
    const provider = model.providers[action];
    const preview = model.previews[action];
    setText(
      `${action}-destination`,
      typeof provider?.destination === "string" && provider.destination
        ? provider.destination
        : "The server will check the configured destination when you try this action.",
    );
    if (!model.attempts.has(action)) {
      const ready = provider?.configured === true;
      setBadge(
        action,
        ready ? "Configured" : "Not configured",
        ready ? "ready" : "not_configured",
      );
      let detail =
        typeof provider?.detail === "string"
          ? provider.detail
          : ready
            ? "The server reports a configured connection. No action has been requested."
            : "Try this action to see which server settings are missing.";
      if (!ready)
        detail +=
          " You can review and try it; the server will report any missing settings.";
      if (!hasPreview(action))
        detail += " The exact server preview is missing; sending is disabled.";
      if (model.authorizationConfigured === false)
        detail += " Lab access is not configured on the server.";
      setText(`${action}-detail`, detail);
    }
    $(`${action}-preview`).hidden = !hasPreview(action);
    if (hasPreview(action)) {
      setText(`${action}-preview-title`, preview.title);
      setText(`${action}-preview-body`, preview.body);
      if (action === "github") setText("github-preview-diff", preview.diff);
    }
  }
  renderSavedReview();
  updateButtons();
}

async function checkServices() {
  if (model.checking || model.sending) return;
  model.checking = true;
  updateButtons();
  setText(
    "service-status",
    "Checking server configuration. No action is being sent…",
  );
  const phraseAtCheck = model.accessPhrase;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    // Read-only: a phrase may reveal the exact destination, but no action body is sent.
    const response = await fetch(API, {
      method: "GET",
      headers: phraseAtCheck
        ? { Authorization: `Bearer ${phraseAtCheck}` }
        : {},
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Configuration could not be checked.");
    const data = await response.json();
    if (!data || typeof data.providers !== "object" || !data.providers)
      throw new Error("Configuration response was incomplete.");
    model.authenticated =
      data.authenticated === true && phraseAtCheck === model.accessPhrase;
    model.providers = data.providers;
    model.previews = data.previews || data.preview || {};
    model.authorizationConfigured = data.authorizationConfigured;
    const ready = ACTIONS.filter(
      (action) => model.providers[action]?.configured === true,
    ).length;
    setText(
      "service-status",
      `${ready} of ${ACTIONS.length} real integrations configured. Choose an action to review and try it; the server reports any missing settings.${model.authenticated ? " Access verified; exact destinations are shown." : " Configured services require the lab access phrase before an external action can run."} This check created nothing.`,
    );
    renderConnections();
  } catch {
    model.authenticated = false;
    model.providers = {};
    model.previews = {};
    renderSavedReview();
    for (const action of ACTIONS) {
      if (!model.attempts.has(action))
        setBadge(action, "Status unavailable", "unknown");
      setText(`${action}-destination`, "Configuration could not be checked.");
      setText(
        `${action}-detail`,
        "No action was sent. Check this deployment’s API and try the status check again.",
      );
      $(`${action}-preview`).hidden = true;
    }
    setText(
      "service-status",
      "Configuration is unavailable. This page needs the deployed preflight API; opening the HTML alone cannot run real integrations. No action was sent.",
    );
  } finally {
    window.clearTimeout(timeout);
    model.checking = false;
    updateButtons();
  }
}

function updateDraft() {
  const channel = $("draft-channel").value;
  const recipient = $("draft-recipient").value.trim();
  const tenant = $("draft-tenant").value.trim();
  const teams = channel === "teams";
  $("tenant-field").hidden = !teams;
  $("draft-tenant").setCustomValidity(
    teams && tenant && !UUID.test(tenant)
      ? "Enter a tenant UUID or leave this optional field empty."
      : "",
  );
  const recipientValid = Boolean(
    recipient &&
    $("draft-recipient").validity.valid &&
    !/[\r\n,;]/.test(recipient),
  );
  const valid = recipientValid && (!teams || !tenant || UUID.test(tenant));
  const link = $("open-draft");
  link.textContent = teams ? "Open Teams draft ↗" : "Open email draft ↗";
  link.setAttribute("aria-disabled", String(!valid));
  link.classList.toggle("disabled-link", !valid);
  if (!valid) {
    link.removeAttribute("href");
    setText(
      "draft-note",
      recipient && !recipientValid
        ? "Enter one valid email address belonging to you."
        : teams && tenant && !UUID.test(tenant)
          ? "Enter a valid tenant UUID or leave it empty."
          : "Enter your own recipient address to prepare the link. No message is sent by this page.",
    );
    return;
  }
  if (teams) {
    const url = new URL("https://teams.microsoft.com/l/chat/0/0");
    url.searchParams.set("users", recipient);
    url.searchParams.set("message", `${DRAFT.title}\n\n${DRAFT.body}`);
    if (tenant) url.searchParams.set("tenantId", tenant);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    setText(
      "draft-note",
      "Opens a Teams chat draft. Your organization’s sign-in and chat policies apply. This page cannot confirm whether you send it.",
    );
  } else {
    link.href = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(DRAFT.title)}&body=${encodeURIComponent(DRAFT.body)}`;
    link.removeAttribute("target");
    link.removeAttribute("rel");
    setText(
      "draft-note",
      "Opens your configured mail client with a draft. You decide whether to send it; this page cannot confirm delivery.",
    );
  }
}

async function openReview(action) {
  if (!ACTIONS.includes(action) || !canReview(action)) return;
  // A supplied phrase reveals the exact destination before confirmation, without writing.
  if (model.accessPhrase && !model.authenticated) {
    await checkServices();
    if (!canReview(action)) return;
  }
  model.pending = {
    action,
    preview: { ...model.previews[action] },
    destination:
      typeof model.providers[action]?.destination === "string"
        ? model.providers[action].destination
        : "The server will check the configured destination when you try this action.",
  };
  setText("confirm-title", `Review ${LABELS[action].toLowerCase()}`);
  setText(
    "confirm-description",
    action === "email"
      ? "This sends a real email to the test recipient below. An accepted response alone does not prove that it reached the inbox."
      : action === "github"
        ? "This creates the proposed change and opens a real pull request. It does not merge the pull request."
        : action === "supabase"
          ? "This writes the reviewed status for NS-1041 to the configured database. The source transaction amounts stay unchanged. The server will read the row back, and you can check it again after reloading."
          : "This creates one real card in the test list below. The server will report whether it could verify the card.",
  );
  setText("confirm-destination", model.pending.destination);
  setText("confirm-preview-title", model.pending.preview.title);
  setText("confirm-preview-body", model.pending.preview.body);
  setText("confirm-preview-diff", model.pending.preview.diff || "");
  $("confirm-preview-diff").hidden = action !== "github";
  $("confirm-consent").checked = false;
  $("confirm-dialog").returnValue = "";
  setText("confirm-send", CONFIRM_LABELS[action]);
  updateButtons();
  $("confirm-dialog").showModal();
}

function closeReview() {
  $("confirm-dialog").close();
  model.pending = null;
  updateButtons();
}

function safeProviderUrl(action, value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hosts = {
      trello: ["trello.com", "www.trello.com"],
      github: ["github.com", "www.github.com"],
      email: ["resend.com"],
      supabase: ["supabase.com"],
    };
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hosts[action].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function appendText(parent, tag, value, className = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function resultFact(parent, label, value) {
  if (typeof value !== "string" && typeof value !== "number") return;
  const group = document.createElement("div");
  appendText(group, "dt", label);
  appendText(group, "dd", String(value));
  parent.append(group);
}

// A fresh authenticated GET is evidence of database persistence, separate from local history.
function renderSavedReview() {
  const container = $("supabase-saved-review");
  container.replaceChildren();
  if (!model.authenticated) {
    appendText(
      container,
      "p",
      "Not checked with verified access. Enter the lab access phrase and check configured services to read the saved review from the server.",
    );
    return;
  }
  const provider = model.providers.supabase;
  if (provider?.configured !== true) {
    appendText(
      container,
      "p",
      "Supabase is not configured. No database read is claimed.",
    );
    return;
  }
  const review = provider.savedReview;
  if (review?.state === "not_found") {
    appendText(container, "strong", "No saved review found");
    appendText(
      container,
      "p",
      "The server read found no saved review for NS-1041. No write was made by this check.",
    );
    return;
  }
  if (
    review?.state !== "verified" ||
    review.recordId !== "NS-1041" ||
    review.status !== "reviewed" ||
    !UUID.test(review.requestId || "")
  ) {
    appendText(container, "strong", "Saved review not verified");
    appendText(
      container,
      "p",
      "This check did not establish a saved reviewed row for NS-1041. Do not infer persistence from the local activity result.",
    );
    return;
  }
  appendText(container, "strong", "Saved review found · server read");
  appendText(
    container,
    "p",
    "Read from Supabase on this connection check. This evidence is independent of this browser’s local action history.",
  );
  const facts = document.createElement("dl");
  facts.className = "result-facts";
  resultFact(facts, "Record", review.recordId);
  resultFact(facts, "Saved status", review.status);
  resultFact(facts, "Request ID", review.requestId);
  resultFact(facts, "Updated at", review.updatedAt);
  resultFact(facts, "Database row ID", review.id);
  container.append(facts);
}

function renderResult(action, result, requestId) {
  const state = Object.hasOwn(STATE_LABELS, result.state)
    ? result.state
    : "unknown";
  setBadge(action, STATE_LABELS[state], state);
  const container = $(`${action}-result`);
  container.replaceChildren();
  container.hidden = false;
  appendText(container, "strong", STATE_LABELS[state]);
  const fallback = {
    verified:
      "The server reports a successful read-back check. Review the evidence and the provider record below.",
    accepted:
      "The provider accepted the request, but the resulting action has not been independently verified here.",
    unknown:
      "The outcome could not be confirmed. Do not send again; inspect the provider using the request ID.",
    rejected: "The request was rejected. No successful action is claimed.",
    not_configured:
      "The server reports that this integration is not configured. No successful action is claimed.",
  };
  appendText(
    container,
    "p",
    typeof result.message === "string" ? result.message : fallback[state],
  );
  if (state === "accepted" || state === "unknown")
    appendText(
      container,
      "p",
      action === "email"
        ? "Check the recipient inbox and the provider record. Acceptance is not proof of inbox delivery. Do not repeat an uncertain send."
        : "Do not repeat this action while its outcome is uncertain. Check the provider first.",
      "result-warning",
    );
  if (state === "verified" && action === "email")
    appendText(
      container,
      "p",
      "A verified provider record is not proof that a person received or read the email. Check your own inbox.",
      "result-warning",
    );
  if (Array.isArray(result.missing)) {
    const missing = result.missing.filter(
      (name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(name),
    );
    if (missing.length)
      appendText(
        container,
        "p",
        `Missing server settings: ${missing.join(", ")}.`,
        "result-warning",
      );
  }
  const facts = document.createElement("dl");
  facts.className = "result-facts";
  resultFact(facts, "Request ID", requestId);
  resultFact(
    facts,
    "Provider",
    typeof result.provider === "string" ? result.provider : LABELS[action],
  );
  resultFact(facts, "Provider ID", result.id ?? result.providerId);
  resultFact(facts, "Provider status", result.providerStatus);
  resultFact(facts, "Delivery event", result.deliveryState);
  resultFact(facts, "Saved status", result.savedStatus ?? result.status);
  resultFact(facts, "Updated at", result.updatedAt);
  resultFact(facts, "Checked at", result.checkedAt);
  resultFact(facts, "HTTP status", result.httpStatus);
  if (typeof result.verification === "string")
    resultFact(facts, "Verification", result.verification);
  else if (typeof result.verification === "boolean")
    resultFact(facts, "Verification match", result.verification ? "Yes" : "No");
  else if (result.verification && typeof result.verification === "object") {
    for (const [key, value] of Object.entries(result.verification).slice(
      0,
      20,
    )) {
      const label = `Check: ${key.replace(/([a-z])([A-Z])/g, "$1 $2")}`;
      resultFact(
        facts,
        label,
        typeof value === "boolean"
          ? value
            ? "Passed"
            : "Not established"
          : value,
      );
    }
  }
  container.append(facts);
  const href = safeProviderUrl(action, result.url);
  if (href) {
    const link = appendText(container, "a", "Inspect the provider record ↗");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  setText(
    `${action}-detail`,
    !model.attempts.has(action) &&
      (state === "not_configured" || state === "rejected")
      ? "No external action was performed. Correct the reported settings or access phrase, then try again."
      : "An action was requested. Keep the request ID and inspect the result before taking another step.",
  );
}

// Keep evidence and the duplicate guard across reloads. The access phrase is never serialized.
function saveAttempts() {
  try {
    localStorage.setItem(
      ATTEMPTS_KEY,
      JSON.stringify(
        [...model.attempts.entries()].map(([action, attempt]) => {
          const result = {};
          for (const key of [
            "state",
            "message",
            "provider",
            "id",
            "providerId",
            "url",
            "deliveryState",
            "providerStatus",
            "httpStatus",
            "verification",
            "checkedAt",
          ]) {
            if (attempt.result[key] !== undefined)
              result[key] = attempt.result[key];
          }
          return [action, { requestId: attempt.requestId, result }];
        }),
      ),
    );
  } catch {
    setText(
      "service-status",
      "Browser storage is unavailable. Keep each request ID yourself and do not reload or repeat an uncertain action.",
    );
  }
}

function restoreAttempts() {
  try {
    const saved = JSON.parse(localStorage.getItem(ATTEMPTS_KEY) || "[]");
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [action, attempt] = entry;
      if (
        !ACTIONS.includes(action) ||
        !UUID.test(attempt?.requestId || "") ||
        !attempt.result ||
        !Object.hasOwn(STATE_LABELS, attempt.result.state)
      )
        continue;
      model.attempts.set(action, attempt);
      renderResult(action, attempt.result, attempt.requestId);
    }
  } catch {
    /* A malformed local record must never create an external action. */
  }
}

async function performAction(event) {
  event.preventDefault();
  const pending = model.pending;
  if (!pending || !$("confirm-consent").checked || !canReview(pending.action))
    return;
  const action = pending.action;
  const requestId = crypto.randomUUID();
  model.sending = true;
  model.attempts.set(action, {
    requestId,
    result: {
      state: "unknown",
      message:
        "This request was started, but its outcome has not yet been established. Inspect the provider before any further action.",
    },
  });
  saveAttempts();
  const accessPhrase = model.accessPhrase;
  closeReview();
  renderResult(
    action,
    {
      state: "unknown",
      message:
        "Request in progress. Keep this request ID; do not reload or send again while the outcome is pending.",
    },
    requestId,
  );
  setBadge(action, "Request in progress", "pending");
  setText(
    `${action}-detail`,
    "Sending one confirmed request. Do not reload or repeat the action while it is in progress.",
  );
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);
  let result;
  try {
    // No editable payload or destination is accepted. The server owns the exact previewed template.
    const response = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessPhrase ? { Authorization: `Bearer ${accessPhrase}` } : {}),
      },
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({ action, requestId, confirmed: true }),
    });
    result = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !Object.hasOwn(STATE_LABELS, result.state)
    )
      result = {
        state: "unknown",
        message:
          "The server returned no recognized outcome. The action may have occurred. Inspect the provider before doing anything else.",
      };
    if (result.requestId && result.requestId !== requestId)
      result = {
        state: "unknown",
        message:
          "The response did not match this request ID. No outcome can be verified here. Inspect the provider before doing anything else.",
      };
    // Only explicit pre-action auth/configuration errors unlock a deliberate retry.
    // A provider rejection may have left partial effects, so it stays locked.
    if (
      (response.status === 401 && result.state === "rejected") ||
      (response.status === 503 && result.state === "not_configured")
    )
      model.attempts.delete(action);
  } catch {
    result = {
      state: "unknown",
      message:
        "The connection ended before an outcome could be confirmed. The action may already have occurred. Do not resend; inspect the provider using this request ID.",
    };
  } finally {
    window.clearTimeout(timeout);
    model.sending = false;
  }
  if (model.attempts.has(action))
    model.attempts.set(action, { requestId, result });
  saveAttempts();
  renderResult(action, result, requestId);
  updateButtons();
}

$("lab-access").addEventListener("input", () => {
  model.accessPhrase = $("lab-access").value.trim();
  model.authenticated = false;
  renderSavedReview();
  setText(
    "service-status",
    "Access phrase updated. Open an action to review its destination, or refresh configured services. Changing this field sends no action.",
  );
  updateButtons();
});
$("clear-access").addEventListener("click", () => {
  model.accessPhrase = "";
  model.authenticated = false;
  $("lab-access").value = "";
  renderSavedReview();
  updateButtons();
});
$("check-services").addEventListener("click", checkServices);
$("read-saved-review").addEventListener("click", checkServices);
for (const id of ["draft-channel", "draft-recipient", "draft-tenant"])
  $(id).addEventListener("input", updateDraft);
$("open-draft").addEventListener("click", (event) => {
  if ($("open-draft").getAttribute("aria-disabled") === "true")
    event.preventDefault();
});
document
  .querySelectorAll(".review-action")
  .forEach((button) =>
    button.addEventListener("click", () => openReview(button.dataset.action)),
  );
$("confirm-consent").addEventListener("change", updateButtons);
$("close-confirm").addEventListener("click", closeReview);
$("cancel-confirm").addEventListener("click", closeReview);
$("confirm-dialog").addEventListener("close", () => {
  model.pending = null;
  updateButtons();
});
$("confirm-form").addEventListener("submit", performAction);
window.addEventListener("pagehide", () => {
  model.accessPhrase = "";
  $("lab-access").value = "";
});
setText("draft-subject", DRAFT.title);
setText("draft-body", DRAFT.body);
restoreAttempts();
updateDraft();
updateButtons();
checkServices();
