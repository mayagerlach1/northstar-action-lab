import test from "node:test";
import assert from "node:assert/strict";
import { createGithubIssue } from "./github-issue.mjs";

const config = {
  owner: "student",
  repo: "practice",
  token: "test-secret-never-return",
};
const action = {
  title: "Review synthetic margin",
  body: "A synthetic margin needs review.",
  recordId: "ORDER-001",
  requestId: "request-001",
};
const created = {
  id: 123,
  number: 7,
  html_url: "https://github.com/student/practice/issues/7",
};

test("creates exactly one request and returns linkage and a validated external URL", async () => {
  const calls = [];
  const result = await createGithubIssue(config, action, {
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify(created), { status: 201 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    "https://api.github.com/repos/student/practice/issues",
  );
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${config.token}`);
  const body = JSON.parse(calls[0][1].body);
  assert.match(body.body, /Source record: `ORDER-001`/);
  assert.match(body.body, /<!-- ie-lab-action:request-001 -->/);
  assert.deepEqual(Object.keys(body).sort(), ["body", "title"]);
  assert.equal(result.state, "created");
  assert.equal(result.requestId, action.requestId);
  assert.equal(result.recordId, action.recordId);
  assert.equal(result.issueUrl, created.html_url);
  assert.equal(JSON.stringify(result).includes(config.token), false);
});

test("invalid configuration and payload never send a network request", async () => {
  let calls = 0;
  const options = {
    fetchImpl: async () => {
      calls++;
      throw new Error("must not call");
    },
  };
  for (const changed of [
    { ...config, token: "" },
    { ...config, repo: "../other" },
    { ...config, owner: "student/other" },
  ]) {
    assert.equal(
      (await createGithubIssue(changed, action, options)).state,
      "invalid",
    );
  }
  for (const changed of [
    { ...action, title: " " },
    { ...action, body: "" },
    { ...action, requestId: "bad\nmarker" },
    { ...action, recordId: "" },
  ]) {
    assert.equal(
      (await createGithubIssue(config, changed, options)).state,
      "invalid",
    );
  }
  assert.equal(calls, 0);
});

test("permission rejection is distinct from an unknown result and never exposes response secrets", async () => {
  const result = await createGithubIssue(config, action, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ message: config.token }), { status: 403 }),
  });
  assert.equal(result.state, "rejected");
  assert.equal(result.httpStatus, 403);
  assert.equal(JSON.stringify(result).includes(config.token), false);
});

test("timeouts, server errors and malformed success responses remain unknown with no automatic retry", async () => {
  for (const factory of [
    () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
    () => new Response("Server error", { status: 500 }),
    () => new Response("Request timeout", { status: 408 }),
    () => new Response("invalid JSON", { status: 201 }),
    () =>
      new Response(
        JSON.stringify({
          ...created,
          html_url: "https://evil.example/issues/7",
        }),
        { status: 201 },
      ),
  ]) {
    let calls = 0;
    const result = await createGithubIssue(config, action, {
      fetchImpl: async () => {
        calls++;
        return factory();
      },
    });
    assert.equal(result.state, "unknown");
    assert.equal(result.code, "CHECK_DESTINATION_BEFORE_RETRY");
    assert.equal(calls, 1);
  }
});
