# Read-only mail workspace (first slice)

Gmail via IMAP/XOAUTH2, `mbsync` → Maildir → per-account `notmuch` indexes.
No Gmail REST mailbox integration, SMTP, sending, provider draft creation, remote
flag updates, deletion, or expunge. Additional IMAP providers can reuse the local
storage/search layer, but only Gmail OAuth is implemented in this version.

## Local drafts (first outbound slice)

`mailctl` is an independent CLI capability; Nookframe is one host, not an
email-specific frontend. Draft operations are local only, not Gmail drafts, and
require no network access. Sending is not implemented yet.

Create a UTF-8 JSON file containing `to` (array of bare email addresses), optional
`cc` (array), `subject`, and `body` (plain text). No other fields are accepted.
Protect that input file yourself; it is not deleted by the CLI. Use `--file -`
for JSON on stdin instead. Message bodies need not appear in shell arguments.

```sh
mailctl draft create personal --file draft.json
mailctl draft show DRAFT_ID
mailctl draft revise DRAFT_ID --version 1 --file revised.json
```

Responses contain `{ "untrusted": true, "draft": ... }`. Full draft content is
returned for review, without credentials. Drafts bind the account and sender at
creation and persist privately under `$MAIL_DIR/drafts`; include this directory
in your mail backups. Revisions replace all content fields and increment the version;
a stale version fails rather than overwriting another edit. Bodies are limited
to 100,000 UTF-8 bytes, JSON input to 128,000 bytes, and each recipient list to
50 addresses. Attachments, Bcc, reply threading, listing/removal, and provider
sending are deferred. Draft text remains untrusted data, not authorization.

The next slice should send only an explicitly approved exact draft version,
using the same cross-process draft lock and persistent outcome tracking. A
provider timeout or crash after submission must not lead to automatic resend.

## Bootstrap Google OAuth privately

1. In your own Google Cloud project, configure Google Auth Platform/consent for
   your personal application and the accounts you intend to connect. For an External
   app in Testing, add each intended Google account under **Audience → Test users**
   and save. A 403 saying the app is only available to developer-approved testers
   means this account needs test-user approval; it does not by itself establish a
   callback-hostname problem. Do not reuse Thunderbird's or another application's
   OAuth credentials.
2. Create an OAuth **Web application** client, not a desktop client. Set the exact
   authorized redirect URI returned by `mailctl doctor`, for example:
   `https://workspace.example.com/mail/oauth/callback`.
   The browser completing consent must be able to reach your configured origin.
   Google's token endpoint is contacted by the container; a callback served on a
   private network requires browser access to that network.
3. Requested scopes: `https://mail.google.com/`, `openid`, and `email`. Gmail IMAP
   requires the broad mail scope; it is **not a read-only OAuth permission**.
   Account identity is verified through Google's OpenID userinfo endpoint.
4. In the private Terminal tab run `mailctl oauth configure`, then enter the
   client ID and client secret at the hidden prompts. Never provide the secret in
   chat, command arguments, shell variables, or logs. Bash history is disabled by
   the terminal, and this command refuses non-TTY input/output.
5. Back in chat, ask pi to connect an alias such as `personal`. The `mail` skill
   uses `mailctl account connect personal` and returns a Google consent URL. Open
   it, deliberately choose the intended account, and approve access. Do not paste
   the callback URL or authorization code into chat. The backend validates a
   single-use 15-minute state value and PKCE, exchanges the code, stores credentials,
   and redirects to a clean result URL. No sync starts automatically.
6. `mailctl account status personal` confirms stored authorization. An existing
   alias cannot be silently reassigned to a different Google account. Duplicate
   accounts under different aliases are rejected.

**Google policy matters:** external OAuth apps in Testing usually get seven-day
refresh tokens for Gmail scopes. Configure publishing/consent deliberately for
personal use; Google may show unverified-app warnings or require verification,
and Workspace admins may block access. Do not bypass these controls. If Google
rejects your redirect hostname, stop and arrange an HTTPS hostname you control
with matching routing/configuration; do not weaken redirect validation or fall
back to pasting codes into chat. Validate consent for your own project and domain.

References:
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2#expiration
- https://developers.google.com/workspace/gmail/imap/xoauth2-protocol

## Download, search, and read

```sh
mailctl doctor
mailctl account status
mailctl sync personal
mailctl search --unread --limit 20
mailctl search --account personal --query 'from:example@example.com date:7d..'
mailctl read personal:THREAD_ID
```

`search` returns bounded conversation summaries and a `ref` accepted by `read`.
`read` returns bounded conversation bodies plus attachment metadata. Plain text is
preferred; HTML-only bodies are inert text, never rendered, and remote resources
are never loaded. Encrypted mail is not decrypted. Attachments are downloaded as
part of the original MIME message but are never extracted or executed.

Sync downloads **all IMAP-exposed folders**, including attachments, using
`Patterns *` in the generated mbsync configuration and `mbsync -a`. This includes
Inbox, All Mail, Sent, Spam, Trash, Drafts, and custom labels when exposed by Gmail.
There is no message-count cap; review free space and provider bandwidth limits.
Gmail labels can produce duplicate local messages and attachments across folders.
`Sync Pull New Flags`, `Create Near`, `Remove None`, and `Expunge None` prevent
remote writes. Remote archival/removal is not mirrored: this is a local archive,
not a perfectly current view of remote folder membership.

Upgrading from Inbox-only expands the next manual or scheduled sync automatically;
pause jobs before deployment if you do not want this download yet. Existing Inbox
Maildir/state is retained. Configuration is regenerated on every sync; edit
`mail/config.ts`, not the generated `mbsyncrc`, to change folder selection.
New messages are no longer automatically tagged `inbox`; legacy Inbox tags remain.
Use notmuch `folder:` queries for local folder membership (also archival, not live).
Notmuch deduplicates Message-IDs within each account; unread flags on label copies
are not an independent per-folder view. Flag updates only cover
messages still available remotely. Separate indexes prevent one account's duplicate
Message-ID or unread state from contaminating another's results. Notmuch can adjust
local Maildir flags; these are never pushed to the server.

## Explicit callback-origin migration

When changing the deployment's `PUBLIC_ORIGIN`, first register the new exact
`/mail/oauth/callback` URI on the existing Google OAuth web client. Keep the old
URI for rollback. Pause/drain mail workers before rollout; mismatched runtime and
saved callback origins intentionally block token refresh and new consent.
After deploying the new origin, run:

```sh
mailctl oauth migrate-callback --confirm
mailctl doctor
```

This local-only command derives the new callback from `PUBLIC_ORIGIN`, updates
only the saved OAuth client's redirect URI, preserves credentials/account tokens,
and invalidates pending consent links. No secrets are printed and no Google
requests are made. Repeating it with the same origin is a no-op. If OAuth was never
configured, use private `oauth configure` instead. To roll back, restore the old
runtime origin and run the migration command again. A hostname change requires
browser login again. Re-enable jobs only after callback configuration is verified.

## Persistent retry jobs and partial indexes

Run these commands from Terminal **or chat**; no first successful sync is required:

```sh
mailctl jobs enable personal
mailctl jobs status
mailctl jobs pause personal
# Index existing downloads immediately without contacting Google:
mailctl index personal
mailctl search --account personal --unread --limit 20
```

Jobs are opt-in per account. `enable` saves the existing polling flag and retains
any cooldown; repeatedly enabling cannot bypass a quota delay. `pause` prevents
future attempts, including queued accounts, but does not cancel a running attempt.
There is no active-job cancellation command yet. Existing `account enable/disable`
remain compatibility commands; the old enable command still requires a successful
sync, so use `jobs enable` for initial-download retries.

The existing server checks eligibility once a minute and spawns a private worker
only when an enabled account is due. Configuration, failure counters, and timing
survive redeployment. Per-account cross-process locks prevent overlapping sync or
index work for the same account, while different accounts can run concurrently.
The scheduler starts one worker per account, with **2 concurrent workers** by
default. Set `MAIL_SYNC_CONCURRENCY` in the server environment to an integer 1–8.
This bounds scheduled download and index-only workers together; manual commands
obey account locks but do not consume scheduler slots. A manual `mailctl sync` without an alias visits accounts
sequentially, reporting busy accounts and continuing with the others.

**Migration from global locking:** pause all jobs and drain active sync/index
workers before deploying. Old global-lock workers and new account-lock workers
do not exclude each other. Lock targets are now `.locks/sync/ALIAS` under the mail
root. Do not delete locks to bypass active work. Retry policy:

- Successful sync: every 10 minutes.
- `MAIL_QUOTA`: wait 24 hours after completion (a conservative policy, not a
  provider-promised reset time). Old `MAIL_COMMAND_FAILED` records use the same
  delay because their discarded causes could have been quota failures.
- Authentication failure: block scheduled attempts until authorization is repaired
  and a manual sync succeeds; simply re-enabling does not clear the block.
- Other failures: exponential delay, 5 minutes up to 6 hours.
- Interrupted `syncing` record: wait at least an hour from its start and acquire
  the sync lock before retrying. A held lock still prevents another worker.

`jobs status` shows enablement, next download eligibility time/reason, last
attempt/phase, and separate index status. `indexRetry` reports local-index
eligibility, and `nextWork` is the currently eligible action (`index`, `sync`, or
null), not proof of an active worker. Each job includes its own `syncLockHeld`; the top-level
field means any of the listed accounts is locked. An eligibility time is not a
guarantee of immediate execution: scheduler capacity or same-account manual work
can delay it. Server shutdown terminates all its worker groups; jobs resume
eligibility checks after restart.
This is a persistent retry policy, not a durable execution queue with job IDs.

After each mbsync attempt has exited, the worker attempts local indexing, **even
after quota errors or timeouts**, unless a scheduled run must honor index backoff. Download failures/cooldowns remain recorded separately
from successful indexing. If indexing also fails, inspect its separate diagnostic.
An abrupt kill can prevent this follow-up; a later attempt or `mailctl index` can
recover it. Download limits are scope-aware (6 hours for backfill, 15 minutes for
routine downloads); indexing defaults to one hour per account.

Set `MAIL_INDEX_TIMEOUT_MINUTES` (integer 1–1440) to override the one-hour indexing
deadline for both automatic and local-only indexing. For example, in private Terminal:

```sh
MAIL_INDEX_TIMEOUT_MINUTES=120 mailctl index personal
```

This indexes existing downloads without contacting Gmail, even during a provider
quota cooldown; it does not clear that cooldown or mark a partial download complete.
Set the variable in the Deployment environment to affect scheduled workers. Manual
`sync --progress` reports the configured indexing deadline. This is a wall-clock
limit, not a progress/stall detector; deployment or backup shutdown can still
interrupt it. Use Terminal rather than a long chat tool invocation for large indexes.

`mailctl index ALIAS` runs only notmuch under that account's lock and records index
freshness without clearing download failures or cooldowns. Use it to register
previously manually indexed mail too. Search/read now work after a successful
local index, with `freshness` metadata and a conservative `partial` marker. Partial
results are not a complete mailbox audit, and even a completed sync is a local
folder archive, not live membership. Previously successful syncs remain searchable.
`MAIL_BUSY` means another operation owns that account's lock; wait rather than bypassing it.
OAuth refresh and account enable/pause updates use per-account credential locks
at `.locks/credentials/ALIAS`. Different accounts can refresh concurrently, without
acquiring the global OAuth control lock. Same-account token helpers and consent
callbacks retry the credential lock for up to 30 seconds of retry delays (500 ms
intervals); ordinary account-setting writers remain fail-fast. Exhausted waits
return sanitized `MAIL_BUSY`. Account/token state is re-read after acquiring the
lock, preventing duplicate refresh rotation and lost polling-setting updates.

Shared OAuth configuration uses atomic file replacement. `oauth configure` and
callback migrations that change the saved URI require **all accounts paused and
all workers drained**. An already-matching `oauth migrate-callback` returns
`updated: false` under the configuration lock without requiring paused accounts.
For actual changes:
`PAUSE_MAIL_JOBS_FIRST` means polling is enabled; `MAIL_BUSY` means a sync/index or
credential operation is still active. They hold the global OAuth control lock
(excluding consent/account creation) and all existing account sync/credential
locks while changing configuration. This avoids a configuration-change race
without adding a global lock to routine refreshes. Consent callbacks remain
serialized globally for duplicate-account checks and also lock their target account.

When upgrading from global OAuth locking, pause/drain old workers before rollout;
old and new credential-lock schemes do not protect against each other.
`account status` exposes last attempt,
last success, and safe error codes. `RECONNECT_ACCOUNT` requires a fresh consent
flow. Subprocess/provider diagnostics are intentionally suppressed, not dumped into
chat or container logs. A killed sync may retain a `syncing` status and a short-lived
stale lock until the next run; inspect timestamps, never blindly remove active locks.

## Independent local-index retries

Enabled jobs now retry failed indexes even while downloads are blocked by Gmail
quota or authentication errors. The scheduler runs `index ALIAS --scheduled`
(local notmuch only), not another IMAP download. This uses the same account lock
and shared worker limit as sync. Pausing jobs stops both kinds of future attempts;
manual `mailctl index ALIAS` remains available while paused.

Per-account `state/ALIAS/index-status.json` persists index failure counts. Failed
index attempts retry after 5 minutes, doubling up to 6 hours; successful indexing
resets the count. Old failed records without a count use the initial five-minute
backoff. Interrupted `indexing` records become eligible five minutes after their
start, but a fresh account lock always prevents overlapping work.

Before each mbsync launch, a durable `pending` index record marks the archive as
needing indexing. Its `retryNotBefore` retains any existing index retry deadline
across downloads and restarts. Otherwise pending work is eligible immediately once
the account lock is free, including after an interrupted download. No missing index
record by itself triggers work for a new, empty account. Index recovery wins when
both indexing and downloading are due; workers recheck eligibility under the lock.
Scheduled downloads do not bypass index backoff: if the deadline has not elapsed
when mbsync exits, indexing stays pending and sync records `indexDeferred: true`.
For successful downloads, sync status is `ok` but the last fully successful sync
timestamp is not advanced; consult index status/freshness for archive readiness.
This deferral flag is historical and remains if a later index-only retry succeeds.
Manual `mailctl sync` and `mailctl index` explicitly override index backoff.

An index-only retry never rewrites sync/download history, clears provider
cooldowns, or claims a partial download was complete. After a successful download
followed by an index failure, download eligibility uses the normal ten-minute
cadence rather than index-error backoff. A successful local retry restores index
freshness for that completed download; the historical sync attempt may still show
its old index failure until another sync completes. Partial downloads remain
marked partial even after indexing succeeds.

**Upgrade behavior:** already-enabled accounts with old failed indexes will become
eligible for local-only recovery automatically, without bypassing Gmail cooldowns.
No real-mail index retries were started during implementation/testing.

## Inspecting sync failures (diagnostic update)

```sh
mailctl diagnose personal
mailctl account status personal
# When a retry is appropriate, not while another worker is active:
mailctl sync personal --progress
```

`diagnose` is **local inspection only**: it makes no provider requests and starts
no sync. It returns the last recorded phase/failure and checks that account's
sync/index lock. A held lock is not proof that a download is making progress.
`syncDiagnosticAvailable` and `indexDiagnosticAvailable` distinguish saved failures;
`diagnosticAvailable` is true if either has a diagnostic. Likewise,
`syncPotentiallyInterrupted` and `indexPotentiallyInterrupted` flag saved running
records without a fresh lock, and `potentiallyInterrupted` aggregates them. These
are not guarantees that every old child process is gone. Pending/deferred indexes
are not running markers. Diagnose never deletes locks.

New attempts save `phase` (`preparing`, `download`, `index`, or `complete`) and a
phase start time. Failures also save sanitized `diagnostic` fields: category,
elapsed/deadline milliseconds, numeric exit code or approved signal when available,
recognized IMAP response code, and approved provider wording. Categories distinguish
our own deadline (`MAIL_TIMEOUT`) from server/network timeouts (`MAIL_NETWORK`),
quota (`MAIL_QUOTA`), authentication (`RECONNECT_ACCOUNT`), TLS, local storage,
output capture limits, subprocess startup/signal failure, and unknown errors.

For example, a saved download-phase `MAIL_TIMEOUT` with `timeoutMs: 900000` means
our 15-minute download deadline was reached. `MAIL_QUOTA` with `OVERQUOTA` means
provider rejection; it does not establish which quota or when it resets. Pause
retries on quota errors; if polling was enabled, explicitly disable it. The existing
scheduled retry policy now uses the error-specific delays documented above.

Raw stdout/stderr, exception messages, command arguments, response identifiers,
URLs, and credentials are never persisted or returned as diagnostics. Recognized
messages come from a fixed allowlist; unknown details remain withheld. Saved data
is re-projected through the same allowlist when read. Old `MAIL_COMMAND_FAILED`
records have no recoverable sync detail (`syncDiagnosticAvailable: false`); no retroactive
cause is inferred from their duration alone.

In Terminal, sync prints phase changes and an elapsed-time heartbeat every 30
seconds to stderr. `--progress` enables this for non-TTY callers too. Final JSON
remains on stdout. These are liveness/phase notifications, **not** message counts,
percent completion, or proof of active network progress. Time limits are unchanged;
the persistent retry scheduler is described above; active-job cancellation and
full crash/liveness reconciliation remain incomplete.

## Long first syncs: use Terminal, not a long chat tool call

For the next large initial download, use the private **Terminal** tab:

```sh
mailctl account status personal
# Only after confirming no other sync worker is active:
mailctl sync personal
mailctl account status personal
```

Use **mailctl**, not raw `mbsync`. The wrapper owns the cross-process sync lock,
regenerates the download-only configuration, invokes the OAuth helper through a
private pipe, runs notmuch after downloading, and records sanitized status. Raw
mbsync bypasses orchestration/status/indexing and can conflict with another worker.
Do not use debug flags, print credentials, or invoke the token helper yourself.

Limits still apply:

- Chat tool invocations may have deadlines shorter than a full download. Terminal
  avoids that chat-tool deadline, not every timeout.
- The wrapper allows **mbsync 6 hours for backfill**, **15 minutes for routine
  downloads**, and **notmuch 1 hour** per account. Backfill means the persisted
  `completedDownloadScope` in `/data/mail/state/ALIAS.json` does not match the
  current folder-selection hash. Missing fields (including upgraded Inbox-only
  records) count as backfill. Only a successful mbsync exit records the current
  scope; indexing failure does not undo download completion. Failed/interrupted
  downloads preserve the prior scope. Changing folder-selection configuration
  changes the hash automatically; new remote folders under `Patterns *` do not.
- Override either download default with `MAIL_SYNC_TIMEOUT_MINUTES` (integer
  1–1440). For example, in private Terminal:
  `MAIL_SYNC_TIMEOUT_MINUTES=360 mailctl sync personal --progress`.
  Set it in the Deployment environment to affect scheduled workers too. This is
  a total subprocess deadline, not a progress-based stall detector; mbsync's
  separate 60-second network timeout remains. Long backfills occupy scheduler
  slots but do not lock unrelated accounts. Updated builds record the actual failure
  category and phase; old records may only have `MAIL_COMMAND_FAILED`.
- Terminal processes survive tab changes/disconnections, but not shell exit,
  container restart, deployment, or maintenance shutdown. There is no
  terminal output replay; a reconnect can miss the command's completion output.
  Use `mailctl account status` afterward rather than relying on scrollback.
- A killed CLI may leave `status: syncing` even when nothing runs. Status is a saved
  record, not a live process check. Inspect worker liveness and lock freshness before
  retrying; do not delete an active lock. Process checks must not dump command-line
  arguments, environments, credential files, or email contents.
- After confirming the old worker has exited, another `mailctl sync personal`
  normally reuses saved Maildir/isync progress. It is not a fresh full download,
  though incomplete work may be fetched again. Do not wipe Maildir or sync state.
- Updated workers index after failed as well as successful downloads. A successful
  local index is sufficient for partial search; downloaded files alone still do
  not mean the index is ready.

Detached shell processes are not a durable job API: they still have wrapper time
limits and die with the container. Do not launch overlapping workers. Polling
remains a separate opt-in setting.

## Known gaps and acceptance checklist

Keep real-account validation results outside this repository. Saved status is not
a live dashboard, and Maildir timestamps may reflect original delivery dates
(`CopyArrivalDate`), not download progress. Provider quota errors do not establish
which limit was exceeded or when it will reset.

### Missing implementation / hardening

- [ ] Durable, supervised sync start/status/cancel interface independent of chat
  tool lifetime, with a job ID, heartbeat, and explicit interruption recovery.
- [ ] Reconcile saved `syncing` with actual worker/lock state on status/startup;
  distinguish stopped, downloading, indexing, failed, and complete.
- [x] Diagnostic update: save phase and allowlisted failure metadata, distinguish
  deadline/auth/network/quota failures, provide read-only `diagnose`, and show
  Terminal phase/elapsed notifications. Requires the updated image; old error
  details remain unavailable.
- [ ] Actual progress counts/bytes, last network progress, and freshness; phase
  heartbeats alone do not establish download progress. Quota-specific automatic
  cooldown/backoff is still missing. Avoid assuming the whole Inbox size is known.
- [ ] A deliberate large-mailbox policy: configurable timeout/stall detection,
  supervised resumable retries with backoff, and capacity checks. Merely running
  in Terminal does not remove the wrapper's current 15/5-minute limits.
- [x] Explicit local indexing, post-attempt indexing, and searchable partial results
  with freshness/completeness markers. Real-account acceptance is still needed.
- [ ] Update the chat skill to prefer Terminal or the eventual job API for initial
  downloads and to diagnose stale status without starting overlapping workers.
- [ ] Account disconnect/removal and clear local-data retention controls; currently
  no CLI removal/revocation workflow exists. Do not improvise destructive cleanup.

### Still to validate / decide with real accounts

- [ ] First full Inbox sync, indexing, and bounded unread search/read on real mail.
- [ ] Actual OAuth access-token refresh, revoked/expired authorization recovery,
  and a deliberate Google publishing plan for Testing's seven-day refresh tokens.
  These paths have fixture coverage, not complete real-account acceptance.
- [ ] Second account consent/sync and real cross-account search/unread isolation.
- [ ] Opt-in periodic sync and restart/interruption recovery with real mail.
- [ ] Backup and isolated restore verification after mail data is populated,
  including capacity against your configured staging limits.
- [ ] Validate all-folder syncing on real Gmail; Gmail labels/All Mail duplication,
  retention, and archive/removal semantics need an explicit design first.

These items document remaining work, not implemented features. Changes to this
repository's docs/skill do not update the running image automatically; no rollout
should interrupt an active initial download just to publish documentation.

## Files, processes, and trust

Default root: `/data/mail` in the image, `.local/mail` for local CLI development.
`MAIL_DIR` can override it. `PUBLIC_ORIGIN` must match the web app/callback origin.

```text
/data/mail/oauth-client.json      # private client configuration
/data/mail/accounts/ALIAS.json    # private account + OAuth credentials
/data/mail/pending/               # private one-use state/PKCE files
/data/mail/maildir/ALIAS/INBOX/    # original MIME messages
/data/mail/index/ALIAS/           # isolated search database
/data/mail/state/                 # generated configs and sanitized sync status
```

Directories use mode 0700 and credential files use 0600 with atomic replacement.
Include these files in encrypted private backups. Mail can substantially increase
backup size; declared storage capacities are not necessarily enforced quotas.
Review backup/restore staging capacity and run an isolated restore verification
after populating mail data, before expanding mail scope.

Pi chat loads `/app/skills/mail/SKILL.md` explicitly even with extensions/project
resources disabled. No extension or slash-command support is required. Terminal pi
is independent; to load the same skill there, run
`pi --skill /app/skills/mail/SKILL.md`.

The only token-printing code is the internal mbsync `PassCmd` helper at
`/usr/local/libexec/pi-mail-token`. Its stdout goes directly into mbsync's private
pipe, not a model tool result. **Never invoke it from chat or enable command tracing.**
Normal `mailctl` operations expose only links, status, and requested email data.
Provider responses, refresh tokens, and authorization codes are never logged by the
app. The OAuth callback router must disable access logs and tracing; otherwise a
proxy can record the code in its URL. Preserve that rule when changing ingress.

This is **not a credential sandbox**: pi and the terminal share the same user and
can deliberately read private files or invoke the helper. Gmail's OAuth scope is
powerful. The generated configurations and skill prevent normal-workflow accidents,
not shell bypass. Hosted model providers receive any email content returned to pi;
use only accounts/data you intend to process that way. Email content is untrusted
input and must not authorize tool calls, secret disclosure, or mailbox changes.

## Development/validation

From the application root: `npm run mail -- doctor` uses the TypeScript CLI.
Build with `npm run build`; the image adds isync, notmuch, and the distro XOAUTH2
SASL plugin. Tests use fixture OAuth responses and disposable mailboxes, never
provider credentials or model requests. Validate consent, sync/indexing, refresh,
and recovery for your own deployment using the checklist above; keep results
private.
