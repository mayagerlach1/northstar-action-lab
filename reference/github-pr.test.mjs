import test from "node:test";
import assert from "node:assert/strict";
import { createGithubPrClient, githubConfigFromEnv, INITIAL_POLICY, PROPOSED_POLICY, POLICY_FILE } from "./github-pr.mjs";

const requestId = "4ed6f7fd-41b9-41a0-b459-d162e484240c";
const config = { owner: "student", repo: "practice", token: "secret-never-in-output", baseBranch: "fixture-base" };
const blob = (policy) => ({ sha: "blob-sha", encoding: "base64", content: Buffer.from(JSON.stringify(policy)).toString("base64") });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const head = `lab/pr-change/${requestId}`;
const patch = '@@ -3,5 +3,5 @@\n   "negativeMargin": {\n     "reviewTeam": "Finance operations",\n-    "highPriorityBelowProfit": null\n+    "highPriorityBelowProfit": -100\n   }';

test("deployed configuration accepts only explicitly scoped LAB variables and the fixed fixture file", () => {
  assert.throws(() => githubConfigFromEnv({ GH_TOKEN: "general-token", LAB_GITHUB_REPOSITORY: "student/practice" }));
  assert.throws(() => githubConfigFromEnv({ LAB_GITHUB_TOKEN: "lab-token", LAB_GITHUB_REPOSITORY: "student/practice", LAB_GITHUB_POLICY_PATH: "customer-data.json" }));
  const configured = githubConfigFromEnv({ LAB_GITHUB_TOKEN: "lab-token", LAB_GITHUB_REPOSITORY: "student/practice" });
  assert.equal(configured.baseBranch, "main");
  assert.equal(configured.filePath, POLICY_FILE);
  assert.equal(configured.owner, "student");
});

test("a confirmed action creates a branch, one real file commit and a PR against the configured baseline", async () => {
  const calls = [];
  const replies = [response({ object: { sha: "base-sha" } }), response(blob(INITIAL_POLICY)), response({}, 404), response({ ref: `refs/heads/${head}` }, 201), response({ commit: { sha: "change-sha" } }), response({ number: 9, html_url: "https://github.com/student/practice/pull/9" }, 201)];
  const client = createGithubPrClient(config, { fetchImpl: async (...args) => { calls.push(args); return replies.shift(); } });
  const result = await client.createPolicyPullRequest({ requestId, confirmed: true });
  assert.equal(result.state, "created");
  assert.equal(result.commitSha, "change-sha");
  assert.deepEqual(calls.map(([, o]) => o.method), ["GET", "GET", "GET", "POST", "PUT", "POST"]);
  const write = JSON.parse(calls[4][1].body);
  assert.equal(write.branch, head);
  assert.equal(write.sha, "blob-sha");
  assert.deepEqual(JSON.parse(Buffer.from(write.content, "base64").toString()), PROPOSED_POLICY);
  const pr = JSON.parse(calls[5][1].body);
  assert.equal(pr.base, "fixture-base");
  assert.equal(pr.head, head);
  assert.equal(pr.reviewers, undefined);
  assert.equal(JSON.stringify(result).includes(config.token), false);
});

test("unconfirmed, foreign-record and invalid-target actions cannot write", async () => {
  let calls = 0;
  const client = createGithubPrClient(config, { fetchImpl: async () => { calls++; throw new Error(); } });
  assert.equal((await client.createPolicyPullRequest({ requestId, confirmed: false })).state, "invalid");
  assert.equal((await client.createPolicyPullRequest({ requestId, confirmed: true, recordId: "real-customer" })).state, "invalid");
  assert.throws(() => createGithubPrClient({ ...config, filePath: "real-data.json" }));
  assert.throws(() => createGithubPrClient({ ...config, repo: "../other" }));
  assert.equal(calls, 0);
});

test("a changed baseline or existing request branch is not overwritten", async () => {
  for (const existing of [false, true]) {
    const calls = [];
    const replies = [response({ object: { sha: "base-sha" } }), response(blob(existing ? INITIAL_POLICY : PROPOSED_POLICY)), response({ object: { sha: "old-head" } })];
    const client = createGithubPrClient(config, { fetchImpl: async (...args) => { calls.push(args); return replies.shift(); } });
    const result = await client.createPolicyPullRequest({ requestId, confirmed: true });
    assert.equal(result.code, existing ? "REQUEST_BRANCH_ALREADY_EXISTS" : "BASELINE_POLICY_MISMATCH");
    assert.equal(calls.every(([, o]) => o.method === "GET"), true);
  }
});

test("an uncertain commit is not retried and no PR is fabricated", async () => {
  const calls = [];
  const replies = [response({ object: { sha: "base-sha" } }), response(blob(INITIAL_POLICY)), response({}, 404), response({}, 201)];
  const client = createGithubPrClient(config, { fetchImpl: async (...args) => {
    calls.push(args);
    if (calls.length === 5) throw new DOMException("timeout", "TimeoutError");
    return replies.shift();
  } });
  const result = await client.createPolicyPullRequest({ requestId, confirmed: true });
  assert.equal(result.state, "unknown");
  assert.equal(result.stage, "commit_policy_change");
  assert.equal(result.prNumber, undefined);
  assert.equal(calls.length, 5);
});

test("verification requires a real open PR, matching commit and exact single-file diff", async () => {
  for (const extraFile of [false, true]) {
    const files = [{ filename: POLICY_FILE, status: "modified", additions: 1, deletions: 1, patch }];
    if (extraFile) files.push({ filename: "customer-data.json" });
    const replies = [response({ state: "open", head: { ref: head, sha: "change-sha" }, base: { ref: "fixture-base" }, html_url: "https://github.com/student/practice/pull/9" }), response(files), response(blob(PROPOSED_POLICY)), response(blob(INITIAL_POLICY))];
    const client = createGithubPrClient(config, { fetchImpl: async () => replies.shift() });
    const result = await client.verifyPolicyPullRequest({ prNumber: 9, expectedHead: head, expectedBase: "fixture-base", expectedCommitSha: "change-sha" });
    assert.equal(result.state, extraFile ? "unverified" : "verified");
    if (!extraFile) assert.equal(result.checks.exactOneFileDiff, true);
  }
});
