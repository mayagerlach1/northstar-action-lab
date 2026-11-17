#!/usr/bin/env node
/**
 * Synthetic, explicitly opted-in live test. No account or board is created.
 * Env: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_LIST_ID (trusted server values).
 * node preflight-trello.mjs --send [--request-id test-uuid] [--output evidence.json]
 * node preflight-trello.mjs --verify-only CARD_ID --request-id ORIGINAL_REQUEST_ID
 * The created card remains in your configured list. A timeout must be inspected
 * before another POST: Trello create-card has no idempotency guarantee.
 * Evidence confirms this Node helper only, not a deployed application's UI.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createTrelloCard, verifyTrelloCard, trelloCardPayload, trelloConfigFromEnv, validateTrelloDestination } from "./trello-card.mjs";

const requiredVariables = ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LIST_ID"];
const help = "Trello synthetic preflight: configure TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_LIST_ID. Use --send [--request-id ID] [--output NEW_FILE] to create one NS-1041 card and read it back. Use --verify-only CARD_ID --request-id ORIGINAL_ID to read without creating. No action runs without --send or --verify-only. Never put secrets in command arguments.";

export function trelloPreflightAction(requestId) {
  return {
    requestId,
    recordId: "NS-1041",
    title: "[IE synthetic test] Review negative profit on NS-1041",
    body: "Classroom test using a fictional order. No customer data.\nOrder: NS-1041\nRevenue: 1200\nCost: 1320\nRefund: 0\nNet revenue: 1200\nProfit: -120\nRequested action: review the negative profit. No customer contact or automated resolution.",
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

/** Returns only sanitized evidence. Inject fetchImpl in tests; no real API needed. */
export async function runTrelloPreflight(args, env = process.env, options = {}) {
  const base = {
    service: "trello", checkedAt: new Date().toISOString(), recordId: "NS-1041",
    testBoundary: "Node server transport; deployed app and classroom accounts not verified",
    accountPlan: { state: "not_verified", documentation: "https://trello.com/pricing" },
    requiredVariables,
  };
  let flags;
  try { flags = parseArgs(args); } catch {
    return { report: { ...base, state: "blocked", code: "INVALID_ARGUMENTS", help }, exitCode: 2 };
  }
  if (flags.help) return { report: { ...base, state: "help", help }, exitCode: 0 };
  const outputPath = flags.output;
  const config = trelloConfigFromEnv(env);
  const configurationPresent = Object.fromEntries(requiredVariables.map((name) => [name, Boolean(env[name])]));
  if (!validateTrelloDestination(config)) {
    return { outputPath, report: { ...base, state: "blocked", code: "MISSING_OR_INVALID_CONFIGURATION", configurationPresent }, exitCode: 2 };
  }
  if (!flags.send && !flags["verify-only"]) {
    return { outputPath, report: { ...base, state: "blocked", code: "EXPLICIT_OPERATION_REQUIRED", configurationPresent, help }, exitCode: 2 };
  }
  if (flags["verify-only"] && !flags["request-id"]) {
    return { outputPath, report: { ...base, state: "blocked", code: "ORIGINAL_REQUEST_ID_REQUIRED" }, exitCode: 2 };
  }
  const requestId = flags["request-id"] ?? `preflight-${randomUUID()}`;
  const action = trelloPreflightAction(requestId);
  if (!trelloCardPayload(action)) {
    return { outputPath, report: { ...base, state: "blocked", code: "INVALID_REQUEST_ID" }, exitCode: 2 };
  }
  const report = { ...base, requestId, configurationPresent, operation: flags.send ? "create_then_read" : "read_only" };
  let cardId = flags["verify-only"];
  if (flags.send) {
    report.create = await createTrelloCard(config, action, options);
    if (report.create.state !== "created") {
      return {
        outputPath, report: { ...report, state: "not_verified", liveVerified: false,
          nextStep: "Inspect the configured Trello list for this request ID before another create attempt; no automatic retry was made." }, exitCode: 1,
      };
    }
    cardId = report.create.cardId;
  }
  report.readback = await verifyTrelloCard(config, action, cardId, options);
  report.liveVerified = report.readback.state === "verified";
  report.state = report.liveVerified ? "verified" : "not_verified";
  report.nextStep = report.liveVerified
    ? "Open cardUrl to inspect the retained synthetic test card. Account plan and deployed app remain unverified."
    : "Inspect the card; retry only this read-only check with the same card ID and request ID.";
  return { outputPath, report, exitCode: report.liveVerified ? 0 : 1 };
}

async function main() {
  const result = await runTrelloPreflight(process.argv.slice(2));
  const evidence = `${JSON.stringify(result.report, null, 2)}\n`;
  // Exclusive creation avoids overwriting existing evidence or following symlinks.
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
