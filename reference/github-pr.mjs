/** Server-only, dependency-free classroom PR transport. Never expose without app authorization. */
if (typeof window !== "undefined") throw new Error("GitHub PR actions must run on the server.");

export const POLICY_FILE = "classroom-fixtures/review-policy.json";
export const INITIAL_POLICY = {
  schemaVersion: 1,
  synthetic: true,
  negativeMargin: {
    reviewTeam: "Finance operations",
    highPriorityBelowProfit: null,
  },
};
export const PROPOSED_POLICY = {
  ...INITIAL_POLICY,
  negativeMargin: { ...INITIAL_POLICY.negativeMargin, highPriorityBelowProfit: -100 },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,180}$/;
const validBranch = (value) => typeof value === "string" && branchPattern.test(value) && !value.includes("..") && !value.includes("//") && !value.endsWith("/");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const encodedPolicy = (policy) => Buffer.from(`${JSON.stringify(policy, null, 2)}\n`).toString("base64");

function validConfig(config) {
  return config && typeof config.owner === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(config.owner) &&
    typeof config.repo === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(config.repo) &&
    typeof config.token === "string" && config.token.trim() &&
    (!config.baseBranch || validBranch(config.baseBranch)) &&
    (!config.filePath || config.filePath === POLICY_FILE);
}

/** Deployed apps deliberately accept only explicitly configured LAB_* secrets. */
export function githubConfigFromEnv(env = process.env) {
  const [owner, repo, extra] = (env.LAB_GITHUB_REPOSITORY || "").split("/");
  const config = {
    owner, repo, token: env.LAB_GITHUB_TOKEN,
    baseBranch: env.LAB_GITHUB_BASE_BRANCH || "main",
    filePath: env.LAB_GITHUB_POLICY_PATH || POLICY_FILE,
  };
  if (extra || !validConfig(config)) throw new Error("Configure LAB_GITHUB_TOKEN and a fixed LAB_GITHUB_REPOSITORY, baseline branch and classroom fixture path on the server.");
  return config;
}

function failure(error, stage, progress = {}) {
  return {
    ...progress,
    state: error.unknown ? "unknown" : "rejected",
    stage,
    code: error.code || "GITHUB_REQUEST_FAILED",
    ...(error.status ? { httpStatus: error.status } : {}),
    message: error.unknown ? "The result is uncertain. Inspect the named branch or PR before retrying; no write was automatically repeated." : "GitHub rejected this step. Inspect the configuration and any already-created test branch before starting another run.",
  };
}

export function createGithubPrClient(config, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!validConfig(config)) throw new Error("Invalid fixed GitHub server configuration.");
  const root = `https://api.github.com/repos/${config.owner}/${config.repo}`;
  async function api(method, path, body, { allow404 = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "ie-classroom-pr-preflight" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs), redirect: "error", cache: "no-store",
      });
    } catch {
      throw { unknown: method !== "GET", code: "NETWORK_RESULT_UNKNOWN" };
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw { status: response.status, unknown: method !== "GET" && (response.status >= 500 || response.status === 408), code: "GITHUB_REJECTED_STEP" };
    try { return await response.json(); }
    catch { throw { unknown: method !== "GET", status: response.status, code: "UNREADABLE_RESPONSE" }; }
  }
  const refPath = (branch) => `/git/ref/heads/${encodeURIComponent(branch)}`;
  const filePath = (branch) => `/contents/${POLICY_FILE}?ref=${encodeURIComponent(branch)}`;
  function decodeFile(file) {
    if (!file || file.encoding !== "base64" || typeof file.content !== "string" || typeof file.sha !== "string") throw { code: "INVALID_FILE_RESPONSE" };
    try { return JSON.parse(Buffer.from(file.content, "base64").toString("utf8")); }
    catch { throw { code: "INVALID_POLICY_JSON" }; }
  }
  return {
    async repository() {
      const repo = await api("GET", "");
      return { fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, canPush: repo.permissions?.push === true };
    },

    /** Explicit preflight setup: create a separate baseline branch; never write main. */
    async prepareSyntheticBase(requestId) {
      if (typeof requestId !== "string" || !UUID.test(requestId)) return { state: "invalid", code: "INVALID_REQUEST_ID" };
      const baseBranch = `lab/pr-base/${requestId}`;
      const progress = { requestId, baseBranch, filePath: POLICY_FILE };
      let stage = "read_baseline";
      try {
        const sourceBranch = config.baseBranch || "main";
        const source = await api("GET", refPath(sourceBranch));
        const previous = await api("GET", filePath(sourceBranch), undefined, { allow404: true });
        stage = "create_fixture_branch";
        await api("POST", "/git/refs", { ref: `refs/heads/${baseBranch}`, sha: source.object.sha });
        stage = "commit_synthetic_baseline";
        const created = await api("PUT", `/contents/${POLICY_FILE}`, {
          message: "Add isolated synthetic classroom review-policy fixture",
          content: encodedPolicy(INITIAL_POLICY), branch: baseBranch,
          ...(previous?.sha ? { sha: previous.sha } : {}),
        });
        return { ...progress, state: "prepared", baselineCommitSha: created.commit.sha };
      } catch (error) { return failure(error, stage, progress); }
    },

    async createPolicyPullRequest({ requestId, recordId = "NS-1041", confirmed } = {}) {
      if (typeof requestId !== "string" || !UUID.test(requestId) || recordId !== "NS-1041" || confirmed !== true) return { state: "invalid", code: "CONFIRMED_SYNTHETIC_ACTION_REQUIRED" };
      const baseBranch = config.baseBranch || "main";
      const headBranch = `lab/pr-change/${requestId}`;
      const progress = { requestId, recordId, baseBranch, headBranch, filePath: POLICY_FILE };
      let stage = "read_baseline";
      try {
        const base = await api("GET", refPath(baseBranch));
        const file = await api("GET", filePath(baseBranch));
        if (!same(decodeFile(file), INITIAL_POLICY)) return { ...progress, state: "invalid", code: "BASELINE_POLICY_MISMATCH", message: "The fixture differs from the reviewed baseline; inspect it instead of overwriting it." };
        const existing = await api("GET", refPath(headBranch), undefined, { allow404: true });
        if (existing) return { ...progress, state: "rejected", code: "REQUEST_BRANCH_ALREADY_EXISTS", message: "This request already has a branch. Inspect it and its PR before repeating any write." };
        stage = "create_change_branch";
        await api("POST", "/git/refs", { ref: `refs/heads/${headBranch}`, sha: base.object.sha });
        stage = "commit_policy_change";
        const commit = await api("PUT", `/contents/${POLICY_FILE}`, {
          message: "Propose high-priority review for synthetic losses below USD 100",
          content: encodedPolicy(PROPOSED_POLICY), sha: file.sha, branch: headBranch,
        });
        progress.commitSha = commit.commit.sha;
        stage = "create_pull_request";
        const pr = await api("POST", "/pulls", {
          title: "[Classroom test] Escalate synthetic losses below -100",
          head: headBranch, base: baseBranch,
          body: `Synthetic classroom action for NS-1041: revenue USD 1,200, cost USD 1,320, profit -120.\n\nPropose a review policy, not a correction to transaction data: Finance operations should give high priority to profit below -100. Only ${POLICY_FILE} changes from null to -100.\n\nAcceptance: -120 qualifies; -50 does not. The comparison is strictly below -100.\n\nRequest ID: ${requestId}. No real customer data, reviewer assignments or mentions. This test PR targets ${baseBranch} and remains pending review; it must not be merged automatically.`,
        });
        const expected = `https://github.com/${config.owner}/${config.repo}/pull/${pr.number}`;
        if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.html_url?.toLowerCase() !== expected.toLowerCase()) throw { unknown: true, code: "INVALID_PR_RESPONSE" };
        return { ...progress, state: "created", prNumber: pr.number, prUrl: pr.html_url };
      } catch (error) { return failure(error, stage, progress); }
    },

    async verifyPolicyPullRequest({ prNumber, expectedHead, expectedBase, expectedCommitSha } = {}) {
      if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !validBranch(expectedHead) || !validBranch(expectedBase)) return { state: "invalid", code: "INVALID_PR_VERIFICATION" };
      try {
        const pr = await api("GET", `/pulls/${prNumber}`);
        const files = await api("GET", `/pulls/${prNumber}/files?per_page=100`);
        const proposedFile = await api("GET", filePath(expectedHead));
        const baselineFile = await api("GET", filePath(expectedBase));
        const patch = files?.[0]?.patch;
        const matches = pr.state === "open" && pr.head?.ref === expectedHead && pr.base?.ref === expectedBase &&
          (!expectedCommitSha || pr.head.sha === expectedCommitSha) && Array.isArray(files) && files.length === 1 &&
          files[0].filename === POLICY_FILE && files[0].status === "modified" &&
          same(decodeFile(baselineFile), INITIAL_POLICY) && same(decodeFile(proposedFile), PROPOSED_POLICY) &&
          typeof patch === "string" && /^-\s+"highPriorityBelowProfit": null$/m.test(patch) && /^\+\s+"highPriorityBelowProfit": -100$/m.test(patch);
        if (!matches) return { state: "unverified", code: "PR_EVIDENCE_MISMATCH", prNumber };
        return {
          state: "verified", prNumber, prUrl: pr.html_url, baseBranch: expectedBase, headBranch: expectedHead,
          commitSha: pr.head.sha, filePath: POLICY_FILE, filesChanged: files.length,
          additions: files[0].additions, deletions: files[0].deletions, patch,
          checks: { branchAndCommit: true, realPullRequest: true, exactOneFileDiff: true, baselineUnchanged: true, syntheticOnly: true },
        };
      } catch (error) { return failure(error, "verify_pull_request", { prNumber }); }
    },
  };
}
