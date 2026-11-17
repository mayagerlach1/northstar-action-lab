# Northstar · Action Lab

A working dashboard with actions in context: **Overview → Segment → Record**. Click a KPI to share a finding by email, click a chart bar to assign an investigation in Trello, edit a record’s numeric cell to save a correction in Supabase, and report a source problem from that record as a GitHub **issue**.

The four integrations, editable messages, previews, confirmation and verification are implemented. Copy the app, personalize it, connect your own accounts and check the results. You do not build four APIs from scratch or move to a separate action panel.

[Open the dashboard](https://ie-apps-action-lab.vercel.app/) · [Simple guide](https://ie-apps-action-lab.vercel.app/start-here.html) · [Instructor setup](reference/FOUR-ACTIONS.md)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjosncmar%2Fie-apps-action-lab)

## Copy and personalize · 35 minutes

1. Deploy the template with your own GitHub and Vercel accounts. If asked: Framework **Other**, Build command **npm run build**, Output directory **public**.
2. Open your own website URL. The interface, data and buttons work immediately. Trying an unconfigured action shows which server variables are missing; no activation flag is needed.
3. Open your copied repository with your coding assistant. Change the design and use case. Keep the included fictional data or optionally adapt a dataset from a previous class.
4. Push your changes and check your own deployed URL. Keep the three levels and the action context connected.

A starting prompt:

> Personalize this working dashboard for my case. Keep Overview, Segment and Record connected. Attach Share finding to the selected KPI, Assign investigation to the selected chart bar, numeric editing to the record cell, and Report data issue to the record or audit context. Preserve the selected metric, filters, segment and record in each action. Preserve editable messages, explicit confirmation and verification. If we use another dataset, update the interface, server source/context and Supabase seed/allowed records together. Do not change labels while sending the old data. Keep credentials in server settings and show me what you tested.

The included 24 fictional orders make a complete fallback. **NS-1041** has revenue $1,200 and cost $1,320. Its audit note identifies a duplicate $240 freight charge: correcting cost to **$1,080** changes contribution from **−$120 to +$120**. This is a real numeric correction, not a reviewed-status toggle.

## Four contextual exercises

| Level and action | Time | What you do | Evidence |
| --- | --- | --- | --- |
| 1 · Overview / Email | 30 min | Click a KPI, choose **Share finding**, edit recipient, subject and message, then review and confirm. | Selected KPI and current filters in the email, plus the actual message in your inbox. |
| 2 · Segment / Trello | 30 min | Click a region/category bar. Choose **Assign investigation** for that bar, edit title/description and confirm. | A real card with the selected segment, records and requested next step. |
| 3 · Record / Supabase | 35 min | Open NS-1041 **Details →**, inspect its audit note and edit the **Product cost** numeric cell inline: 1320 → 1080, with a reason. Review and confirm the save. | Value saved in the database, contribution recalculated to +120, and the same value after reload/refresh. |
| 4 · Record / GitHub issue | 30 min | From the record row or audit context, choose **Report data issue**; edit the title/body explaining the duplicate charge and requested import fix. | A real issue containing the record and evidence. Opening it changes no source data. |

Initial work 35 min + exercises 125 min + break 10 min + close 10 min = **180 minutes**. An email/Teams draft may be used as an optional warm-up; it is not evidence of sending. There is no PR/branch/merge exercise in this flow.

## Connect your own accounts

Put settings in **your Vercel project → Settings → Environment Variables → Production**, save, then **Deployments → latest deployment → Redeploy**. First save `LAB_ACCESS_KEY`, a random password of **32–256 characters**, in Vercel and your password manager. It protects configured operations; it is not a provider API key. Enter it in **Connections & lab access** or the action dialog. Provider credentials stay in server settings, never in chat or committed files.

| Service | Vercel settings | Preparation |
| --- | --- | --- |
| Email | `RESEND_API_KEY`, `LAB_EMAIL_TO` | Resend **Full access** key. LAB_EMAIL_TO is your own Resend account email. The recipient field is editable, but the current test sender only permits that configured address. |
| Trello | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_LIST_ID` | Your own practice list; **Trello Auth → Generate API key → Token → Allow**. |
| Supabase | `LAB_SUPABASE_URL`; shared `LAB_ACCESS_KEY` | Run supplied `supabase/orders-setup.sql`, then deploy `supabase/orders/index.ts` as **ie-action-lab-orders**, with the hash of your own lab password and its authorization check intact. |
| GitHub | `LAB_GITHUB_TOKEN`, `LAB_GITHUB_REPOSITORY` | A fine-grained token for **Only select repositories → your copy**, with **Issues: Read and write**. Public repository visibility alone does not authorize writes. |

Follow [the simple guide](https://ie-apps-action-lab.vercel.app/start-here.html) or [the exact setup instructions](reference/FOUR-ACTIONS.md). Supabase needs its supplied table and function: a project URL alone does not deploy them. [.env.example](.env.example) lists the setting names.

Buttons remain available without keys. After an attempt, add or correct the variables named by the error, redeploy and retry. Once a provider is configured, real operations require the correct lab phrase. **Refresh data & connections** reads the current database values and settings; it does not make a correction.

## How the numeric correction works

The app edits only **revenue, cost or refund** in the selected record. Values must be nonnegative and refund cannot exceed revenue. The request carries the value and revision you originally read. If someone has already changed the record, the server returns a conflict: reload, inspect the newer value and review again instead of overwriting it.

The function writes one field and reads it back independently. The dashboard then recalculates metrics from the saved values. After reloading, enter your lab phrase and choose **Refresh data & connections** to read the saved figures again. Local action activity is useful context, not proof of persistence. For NS-1041, a successful 1320 → 1080 correction reduces total cost by 240 and increases contribution by 240.

## Verification status

The revised KPI, chart-bar and inline-cell entry points are being checked separately. The evidence below proves the service integrations; it is not a claim that new real actions have been executed through the revised controls.

**All four integrations passed live checks on 17 November 2026** in the earlier published dashboard ([tested commit](https://github.com/josncmar/ie-apps-action-lab/commit/fef782e984cfb9e907b00e9c488de9dfcabede36)).

| Action | Observed evidence |
| --- | --- |
| Overview email | The actual Gmail message matched the edited content and request ID. |
| Segment Trello | [Card jpJ4XnYL](https://trello.com/c/jpJ4XnYL) was created; an independent GET matched its exact content and destination. |
| Record Supabase | Cost 1320 → 1080 persisted at revision 1. Reloaded UI and independent SQL matched the request; record contribution became 120 and total contribution 7,773. |
| Record GitHub | [Issue #2](https://github.com/josncmar/ie-apps-action-lab/issues/2) was created and independently read back with the exact edited content and request ID. |

The instructor’s database now retains cost **1080**. A fresh student project seeds cost **1320** for the exercise; rerunning the seed preserves existing corrections. Do not reset the instructor’s saved correction just to recreate the signal. Each student must still configure and verify their own copy. Account billing screens were not inspected; these checks do not certify a Free plan or quota.

For an uncertain outcome, inspect the existing result before sending again. Keep the request ID. For a numeric conflict, refresh and review the newer record. This classroom lab uses a shared access phrase, not a complete production user system.

## Useful files

| Location | Purpose |
| --- | --- |
| `public/index.html`, `public/app.js` | Integrated Overview → Segment → Record interface. |
| `public/start-here.html` | Learner guide. |
| `api/actions.js`, `server-lib/dashboard-actions.mjs` | Contextual action previews, execution and verification. |
| `supabase/orders-setup.sql` | Seeds 24 numeric records without overwriting existing corrections. |
| `supabase/orders/index.ts` | Protected **ie-action-lab-orders** function with revision checks. |
| `reference/` | Service helpers and tests. |

The old review-status table/function and PR examples are legacy materials, not the current exercise. The legacy ntfy server examples are optional reference code; the current guide follows the three-level dashboard.

## Optional local work

Use Node.js 22 or newer with `npm run dev`, then open http://127.0.0.1:3000. Your assistant can run `npm test` and `npm run build`; mock tests do not establish live account access. The included dataset uses a fixed date of 2026-11-17 and contains no real customers.

After the workshop, clear the lab phrase from the page and revoke temporary provider tokens you no longer use.

## License

MIT. See [LICENSE](LICENSE).

