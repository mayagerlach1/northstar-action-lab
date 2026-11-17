# Contract for a real action

The shipped demo is intentionally a browser practice app. The `POST /api/create-issue` route returns **501 / PRACTICE_MODE_ONLY** and makes no network calls. Complete the contract below before replacing that response. This document is a design contract, not an implemented Supabase backend.

## Server responsibility

An action endpoint is a privileged operation. Keeping a token on the server is necessary but does not stop an anonymous visitor from using an unprotected endpoint to create issues.

Before sending any external request, the server must:

1. Authenticate the app user, for example by verifying a Supabase Auth session using the supported server SDK. Verify the session on the server; a browser-supplied user ID or role is not proof of identity.
2. Authorize that user to read and act on the selected source record. Use owner-aware row policies for client-accessible tables. A logged-in user must not gain access to another student's records.
3. Validate input, the reviewed action and the confirmation. For cookie-authenticated requests, implement same-origin/CSRF protection appropriate to the app.
4. Load the source record from the database. Derive the issue title/body from permitted fields and the bounded, reviewed note. Fix the destination repository in server configuration; do not accept arbitrary URLs, tokens, owner names or repository names from the browser.
5. Persist an action request with a stable request ID. Enforce uniqueness for the authenticated owner and request ID in the database. Atomically claim the request before sending so concurrent clicks do not create two workers for the same request.
6. Call `createGithubIssue` once and store its result. Return only the permitted status and external reference to the client. Apply an app-level rate limit.

The browser must allow the user to review and cancel before submission. Disable the button while sending as a usability measure; the server/database remains responsible for concurrent requests.

## Suggested HTTP contract

This is the contract students can implement after adding authentication and persistence. It is not active in the starter.

```http
POST /api/create-issue
Content-Type: application/json
Authorization: Bearer <the user's verified app session, NOT a GitHub token>
```

```json
{
  "requestId": "a-stable-uuid-for-this-confirmed-action",
  "recordId": "SYNTHETIC-ORDER-001",
  "confirmed": true,
  "reviewedVersion": "the-version-of-the-record-and-preview-the-user-reviewed",
  "note": "Please review the negative margin for this synthetic order."
}
```

Generate the request ID once for the confirmed action. Reusing the same action after a duplicate click must return its saved result. A new intentional action gets a new ID. The server checks the reviewed version against the current source/preview before sending; reject a stale review and show the user the updated content.

Suggested responses:

| HTTP | Result | Browser behavior |
| --- | --- | --- |
| 201 | `created`, request/record IDs, external issue ID and URL | Show the actual external link. |
| 200 | A stored result for the same authorized request ID | Show the existing result without sending again. |
| 202 | `pending` or `unknown` | Show that the result needs confirmation; do not label it successful or blindly retry. |
| 400 | `invalid`, safe validation code | Ask the user to fix the input. |
| 401 / 403 | No valid session or no authority over this record | Require sign-in or show access denied; send nothing externally. |
| 409 | Stale review or reused ID with different content | Refresh the preview or create a new intentional action. |
| 429 | Application rate limit | Show when the user may retry; preserve the request ID. |
| 502 | Confirmed upstream rejection | Show a safe error; preserve diagnostic details server-side without secrets. |
| 501 | `PRACTICE_MODE_ONLY` | Integration has not been implemented; no external effect. |

## Suggested persistence

Use an isolated table in your own practice project. Keep at least:

- request ID, authenticated owner ID and source record ID;
- reviewed content/version and action type;
- `pending`, `sending`, `created`, `rejected` or `unknown` state;
- creation/update timestamps;
- external issue ID/URL when available;
- a safe error code, with no token or sensitive upstream response.

Use a unique constraint on owner/request ID and enforce owner access with row-level security if the table is exposed to a data API. Do not use a service-role key in browser code or turn off row-level security to make the exercise work. If the server uses a privileged database role, authorization must still be enforced explicitly in the server.

The record data in the practice demo is synthetic and browser-readable. Once you add a real database, loading the public JSON is not an authorization check.

## GitHub adapter

Run the transport only after the above checks. For example, inside the server file `api/create-issue.js`:

```js
import { createGithubIssue } from "../reference/github-issue.mjs";

// These values are loaded by your server, never taken from an untrusted browser.
const result = await createGithubIssue(
  {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  },
  {
    requestId: savedRequest.id,
    recordId: authorizedRecord.id,
    title: reviewedTitle,
    body: reviewedBody,
  },
);
// Persist result before returning the safe status/link to the authorized user.
```

`savedRequest`, `authorizedRecord`, `reviewedTitle` and `reviewedBody` in this excerpt stand for values your authenticated implementation has already validated and loaded. The snippet is not a complete request handler.

The helper returns `created`, `rejected`, `invalid` or `unknown`. A timeout can occur after GitHub created the issue. Keep the request's marker, inspect the destination and reconcile the saved request before retrying. GitHub does not deduplicate issue creation merely because the marker is repeated. This example does not promise exactly-once delivery.

## Acceptance checks

Before demonstrating a real integration:

- A signed-out request creates no issue.
- A user cannot act on a different user's record.
- Cancel and invalid input create no issue.
- One reviewed, authorized request creates one issue with the correct record context.
- Reloading preserves the stored request, result and external URL.
- Concurrent/repeated submission of the same request ID does not start a second external send.
- A changed payload with the same request ID is rejected.
- A simulated timeout produces an honest unknown state and no automatic resend.
- The browser bundle, responses and screenshots contain no service secret.

Perform the checks in your own sandbox. A successful command-line preflight verifies the destination API; these checks verify your actual application.
