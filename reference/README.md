# Session 3: a server-side GitHub issue transport

This small Node 22+ example lets an AI assistant inspect a working API contract
without adding a second framework or paid service. It uses GitHub Issues on a
repository you own. Keep test records synthetic.

`github-issue.mjs` sends one confirmed action to GitHub and returns the request ID,
source record ID, external issue ID and URL. It does not implement a web endpoint,
login, database persistence, a queue or duplicate protection. Never expose it as
an unauthenticated public route.

## Configure your practice account

1. Use your own GitHub repository with Issues enabled. A personal practice
   repository avoids organization approval/SSO policies during the lab.
2. Create a fine-grained personal access token restricted to that repository,
   with **Issues: read and write**, an appropriate short expiry and no unnecessary
   permissions. GitHub may add metadata read permission automatically.
3. Enter the token privately in a server environment as `GITHUB_TOKEN`. The CLI
   also accepts an existing `GH_TOKEN`. Do not paste it into an AI conversation,
   source code, a screenshot, a browser request or a `NEXT_PUBLIC_` variable.
4. Fix the repository in server configuration. Do not accept an arbitrary owner,
   repository, destination URL or token from the browser.

Official references:

- https://docs.github.com/en/get-started/learning-about-github/githubs-plans
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://docs.github.com/en/rest/issues/issues#create-an-issue

## Run checks

Offline tests (create no external artifacts):

```sh
node --test reference/github-issue.test.mjs
```

After configuring the server environment privately, run this explicit live test
against your own repository:

```sh
node reference/preflight.mjs --repo YOUR-OWNER/YOUR-REPO --confirm-create --output preflight-result.json
```

This creates one clearly named synthetic issue, reads it back and closes only
that issue after checking its identity and request marker. It never assigns a
person or includes mentions. The result contains status codes and the external
URL, never a token. Check that `readVerified` and `cleanupClosed` are both true.
If a request times out, inspect the destination before repeating the command.
Do not treat an unknown result as proof that nothing happened.

This test verifies the GitHub API from the machine running the command. It does
not verify your deployed app, its authorization, a student's new account/token,
or connectivity from the classroom. Run the app flow separately before class.

## Use it inside an application

Before calling `createGithubIssue`, the application's server must:

1. Authenticate the user and authorize their access to the source record.
2. Verify the explicit confirmation, validate the requested action, and read the
   actual permitted source data on the server.
3. Persist a request with a stable ID. Use a unique constraint and an atomic
   state transition to ensure only one worker executes that request. Disabling
   a button in the browser does not replace this server control.
4. Load the fixed repository and secret from server configuration. In Next.js,
   call the helper from a server module marked `import "server-only"`.
5. Persist the result. Return only the user's permitted status, record/request
   IDs and issue URL to the browser. Rate-limit requests at your application.

The helper returns `created`, `rejected`, `invalid` or `unknown`. A confirmed
creation means a ticket exists, not that its business problem is resolved.
HTTP 5xx, connection loss and malformed successful responses are `unknown`:
the external side effect might already exist. Reconcile the request marker with
GitHub before deciding whether to retry. The marker aids reconciliation; GitHub
does not deduplicate create-issue requests based on this marker. This example
provides no exactly-once guarantee and does not automatically retry mutations.

No sample here installs a token in the course portal or gives students access to
the instructor's repository. Each student configures their own practice app.
