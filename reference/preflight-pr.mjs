/** Explicitly creates an isolated synthetic baseline, change branch and unmerged PR. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createGithubPrClient } from "./github-pr.mjs";

const args = process.argv.slice(2);
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const target = value("--repo");
const [owner, repo, extra] = (target || "").split("/");
const output = value("--output");
if (!args.includes("--confirm-create") || !owner || !repo || extra || !output || output.startsWith("--")) {
  console.error("Usage: node reference/preflight-pr.mjs --repo OWNER/REPO --confirm-create --output result.json");
  console.error("Configure GITHUB_TOKEN or GH_TOKEN privately on the server. This creates two synthetic branches and an unmerged PR; it does not change main.");
  process.exit(2);
}
const config = { owner, repo, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN };
const requestId = randomUUID();
const evidence = {
  checkedAt: new Date().toISOString(), requestId, repository: target,
  transport: "Direct GitHub REST API from Node using a server environment credential; no GitHub connector tool used.",
  scope: "Synthetic review-policy fixture on isolated branches; no merge and no default-branch modification.",
  limitations: ["This command is not a browser/Vercel application test.", "It does not prove a newly issued student fine-grained token is configured correctly.", "A private-repository run does not demonstrate GitHub Free public-repository entitlement."],
};
try {
  let client = createGithubPrClient(config);
  evidence.repositoryInfo = await client.repository();
  if (!evidence.repositoryInfo.canPush) {
    evidence.state = "blocked";
    evidence.reason = "The connected server credential does not have repository push permission.";
  } else {
    config.baseBranch = evidence.repositoryInfo.defaultBranch;
    client = createGithubPrClient(config);
    evidence.fixture = await client.prepareSyntheticBase(requestId);
    if (evidence.fixture.state === "prepared") {
      client = createGithubPrClient({ ...config, baseBranch: evidence.fixture.baseBranch });
      evidence.creation = await client.createPolicyPullRequest({ requestId, recordId: "NS-1041", confirmed: true });
      if (evidence.creation.state === "created") {
        evidence.verification = await client.verifyPolicyPullRequest({
          prNumber: evidence.creation.prNumber, expectedHead: evidence.creation.headBranch,
          expectedBase: evidence.creation.baseBranch, expectedCommitSha: evidence.creation.commitSha,
        });
      }
    }
    evidence.state = evidence.verification?.state === "verified" ? "verified" : "incomplete";
  }
} catch {
  evidence.state = "blocked";
  evidence.reason = "The configured GitHub server credential or API could not be used. Inspect configuration privately; no secret is included in this report.";
}
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
if (evidence.state !== "verified") process.exitCode = 1;
