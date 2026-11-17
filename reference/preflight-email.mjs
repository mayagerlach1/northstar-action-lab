#!/usr/bin/env node
/**
 * Env: RESEND_API_KEY and LAB_EMAIL_TO = your Resend account's own email.
 * Sender is fixed to onboarding@resend.dev. No custom domain or account is created.
 * Use a full_access key for exact readback; sending_access cannot retrieve.
 * https://resend.com/docs/api-reference/api-keys/create-api-key
 * node preflight-email.mjs --send [--request-id test-uuid] [--output evidence.json]
 * node preflight-email.mjs --verify-only EMAIL_ID --request-id ORIGINAL_REQUEST_ID
 * One send, one GET; no automatic resend. Reuse the exact request ID and payload
 * for Resend's 24-hour idempotency window. Inbox inspection is a separate step.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createResendEmail, verifyResendEmail, resendEmailPayload, resendConfigFromEnv, validateResendDestination } from "./resend-email.mjs";

const requiredVariables = ["RESEND_API_KEY", "LAB_EMAIL_TO"];
const help = "Resend synthetic preflight: configure RESEND_API_KEY (send and retrieve permission) and LAB_EMAIL_TO (your own Resend account email). Sender is onboarding@resend.dev. Use --send [--request-id ID] [--output NEW_FILE] for one email plus readback; --verify-only EMAIL_ID --request-id ORIGINAL_ID reads without sending. Provider delivery and manual inbox verification are separate. Never put secrets in command arguments.";

export function emailPreflightAction(requestId) {
  return {
    requestId,
    recordId: "NS-1041",
    title: "[IE synthetic test] Review negative profit on NS-1041",
    body: "Classroom test using a fictional order. No customer data.\nOrder: NS-1041\nRevenue: 1200\nCost: 1320\nRefund: 0\nNet revenue: 1200\nProfit: -120\nRequested action: review the negative profit. This message is a test sent only to the configured account owner's email.",
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--send" || arg === "--help") {
      const key = arg.slice(2);
      if (parsed[key]) throw new Error("Invalid arguments");
      parsed[key] = true;
    } else if (["--verify-only", "--request-id", "--output"].includes(arg)) {
      const key = arg.slice(2);
      const value = args[++index];
      if (parsed[key] || !value || value.startsWith("--")) throw new Error("Invalid arguments");
      parsed[key] = value;
    } else throw new Error("Invalid arguments");
  }
  if (parsed.send && parsed["verify-only"]) throw new Error("Choose one operation");
  return parsed;
}

/** Sanitized API evidence, never a claim of visual inbox arrival or account tier. */
export async function runEmailPreflight(args, env = process.env, options = {}) {
  const base = {
    service: "resend", checkedAt: new Date().toISOString(), recordId: "NS-1041",
    testBoundary: "Node server transport; deployed app and manual inbox arrival not verified",
    accountPlan: { state: "not_verified", documentation: "https://resend.com/pricing" },
    inboxVerified: false, requiredVariables,
  };
  let flags;
  try { flags = parseArgs(args); } catch {
    return { report: { ...base, state: "blocked", code: "INVALID_ARGUMENTS", help }, exitCode: 2 };
  }
  if (flags.help) return { report: { ...base, state: "help", help }, exitCode: 0 };
  const outputPath = flags.output;
  const config = resendConfigFromEnv(env);
  const configurationPresent = Object.fromEntries(requiredVariables.map((name) => [name, Boolean(env[name])]));
  if (!validateResendDestination(config)) {
    return { outputPath, report: { ...base, state: "blocked", code: "MISSING_OR_INVALID_CONFIGURATION", configurationPresent }, exitCode: 2 };
  }
  if (!flags.send && !flags["verify-only"]) {
    return { outputPath, report: { ...base, state: "blocked", code: "EXPLICIT_OPERATION_REQUIRED", configurationPresent, help }, exitCode: 2 };
  }
  if (flags["verify-only"] && !flags["request-id"]) {
    return { outputPath, report: { ...base, state: "blocked", code: "ORIGINAL_REQUEST_ID_REQUIRED" }, exitCode: 2 };
  }
  const requestId = flags["request-id"] ?? `preflight-${randomUUID()}`;
  const action = emailPreflightAction(requestId);
  if (!resendEmailPayload(config, action)) {
    return { outputPath, report: { ...base, state: "blocked", code: "INVALID_REQUEST_ID" }, exitCode: 2 };
  }
  const report = { ...base, requestId, configurationPresent, operation: flags.send ? "send_then_read" : "read_only" };
  let emailId = flags["verify-only"];
  if (flags.send) {
    report.send = await createResendEmail(config, action, options);
    if (report.send.state !== "accepted") {
      return {
        outputPath, report: { ...report, state: "not_verified", providerReadbackVerified: false, deliveryConfirmed: false,
          nextStep: "Inspect the Resend dashboard before another send. No automatic retry was made; the provider retains idempotency keys for 24 hours." }, exitCode: 1,
      };
    }
    emailId = report.send.emailId;
  }
  report.readback = await verifyResendEmail(config, action, emailId, options);
  report.providerReadbackVerified = report.readback.state === "matched";
  report.deliveryState = report.readback.deliveryState ?? "unknown";
  // Open/click events are not independent inbox verification; keep this claim narrow.
  report.deliveryConfirmed = report.providerReadbackVerified && report.deliveryState === "delivered";
  const failedDelivery = ["bounced", "complained", "failed", "suppressed", "canceled"].includes(report.deliveryState);
  report.state = !report.providerReadbackVerified ? "not_verified"
    : failedDelivery ? "delivery_failed" : report.deliveryConfirmed ? "provider_delivered" : "delivery_pending";
  report.nextStep = report.deliveryConfirmed
    ? "Inspect your own inbox separately; provider delivery does not prove visual inbox arrival."
    : "Check delivery with --verify-only and the original email/request IDs; do not send another message just to poll status.";
  // Exit 0 means exact provider readback succeeded without a known failed delivery,
  // not that a delivered event or a visible inbox message has been confirmed.
  return { outputPath, report, exitCode: report.providerReadbackVerified && !failedDelivery ? 0 : 1 };
}

async function main() {
  const result = await runEmailPreflight(process.argv.slice(2));
  const evidence = `${JSON.stringify(result.report, null, 2)}\n`;
  if (result.outputPath) {
    try { await writeFile(result.outputPath, evidence, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch { process.stderr.write("Evidence file was not written. Sanitized evidence is printed below.\n"); result.exitCode = 1; }
  }
  process.stdout.write(evidence);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("Preflight stopped unexpectedly; inspect the provider before any retry.\n"); process.exitCode = 1; });
}
