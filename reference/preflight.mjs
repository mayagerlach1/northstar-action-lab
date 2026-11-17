/** Creates, verifies and closes ONE synthetic GitHub issue, only on explicit opt-in. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  actionMarker,
  createGithubIssue,
  githubHeaders,
  validateDestination,
} from "./github-issue.mjs";

const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const outputIndex = args.indexOf("--output");
const target = repoIndex >= 0 ? args[repoIndex + 1] : "";
const [owner, repo, extra] = (target ?? "").split("/");
const config = {
  owner,
  repo,
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
};
if (
  !args.includes("--confirm-create") ||
  extra ||
  !validateDestination(config)
) {
  console.error(
    "Usage: GITHUB_TOKEN=<server environment> node reference/preflight.mjs --repo OWNER/REPO --confirm-create [--output result.json]",
  );
  console.error(
    "Use your own practice repository and a token with Issues read/write. This creates, reads and closes one synthetic issue. Never paste the token into a prompt or command history; configure the environment privately.",
  );
  process.exit(2);
}
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
if (outputIndex >= 0 && (!outputPath || outputPath.startsWith("--"))) {
  console.error("--output requires a local filename.");
  process.exit(2);
}

const action = {
  recordId: "SYNTHETIC-ORDER-001",
  requestId: `preflight-${randomUUID()}`,
  title: "[Class preflight] Synthetic data review — close after verification",
  body: "This is a synthetic Session 3 integration test, not a real business incident.\n\nRecord: SYNTHETIC-ORDER-001. Example revenue: 100; example cost: 120; margin: -20.\n\nExpected action: verify this issue exists, then close this test issue. No assignee, mention or customer data is included.",
};
const result = {
  checkedAt: new Date().toISOString(),
  repository: `${owner}/${repo}`,
  transport:
    "GitHub REST API from this Node process; not a deployed-app/browser test",
  create: await createGithubIssue(config, action),
  readVerified: false,
  cleanupClosed: false,
};

if (result.create.state === "created") {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${result.create.issueNumber}`;
  try {
    const response = await fetch(url, {
      headers: githubHeaders(config.token),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    result.readHttpStatus = response.status;
    const issue = response.ok ? await response.json() : null;
    const ownIssue =
      issue &&
      issue.id === result.create.issueId &&
      typeof issue.body === "string" &&
      issue.body.includes(actionMarker(action.requestId));
    result.readVerified = Boolean(
      ownIssue &&
      issue.state === "open" &&
      issue.title === action.title &&
      issue.body.includes(action.recordId),
    );
    if (ownIssue) {
      const close = await fetch(url, {
        method: "PATCH",
        headers: githubHeaders(config.token),
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      result.closeHttpStatus = close.status;
      const closed = close.ok ? await close.json() : null;
      result.cleanupClosed = Boolean(
        closed?.id === result.create.issueId && closed?.state === "closed",
      );
    }
  } catch {
    result.followUp =
      "Read or cleanup was interrupted. Check the returned issue URL manually; do not create another issue automatically.";
  }
  if (!result.cleanupClosed) {
    result.followUp =
      "Verify and close the returned synthetic issue URL manually. Its external state has not been confirmed closed.";
  }
} else if (result.create.state === "unknown") {
  result.followUp = `Check the destination for request ${action.requestId} before repeating the test. A request may have succeeded without a readable response.`;
}

const text = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath)
  await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
console.log(text);
if (!(result.readVerified && result.cleanupClosed)) process.exitCode = 1;
