# Read-only mail workspace (first slice)

Gmail via IMAP/XOAUTH2, `mbsync` → Maildir → per-account `notmuch` indexes.
No Gmail REST mailbox integration, SMTP, sending, provider draft creation, remote
flag updates, deletion, or expunge. Additional IMAP providers can reuse the local
storage/search layer, but only Gmail OAuth is implemented in this version.

## Bootstrap Google OAuth privately

1. In your own Google Cloud project, configure Google Auth Platform/consent for
   your personal application and the accounts you intend to connect. For an External
   app in Testing, add each intended Google account under **Audience → Test users**
   and save. A 403 saying the app is only available to developer-approved testers
   means this account needs test-user approval; it does not by itself establish a
   callback-hostname problem. Do not reuse Thunderbird's or another application's
   OAuth credentials.
2. Create an OAuth **Web application** client, not a desktop client. Set the exact
   authorized redirect URI returned by `mailctl doctor`. For the current deployment:
   `https://workspace.example.com/mail/oauth/callback`.
   The browser completing consent must be on your Tailnet. Google's token endpoint
   is contacted by the container; the callback need not be publicly reachable.
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

The first sync downloads the **whole Inbox**, including attachments. There is no
message-count cap or claim of a small initial download; review mailbox size/free
space before running it. No other Gmail label/folder is selected. `Sync Pull New
Flags`, `Create Near`, `Remove None`, and `Expunge None` prevent remote writes.
Remote archival/removal is not mirrored: local messages remain an Inbox archive,
not a perfectly current view of Gmail's Inbox membership. Flag updates only cover
messages still available remotely. Separate indexes prevent one account's duplicate
Message-ID or unread state from contaminating another's results. Notmuch can adjust
local Maildir flags; these are never pushed to the server.

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
survive redeployment. A global sync lock prevents manual/index/scheduled overlap;
accounts run sequentially. Retry policy:

- Successful sync: every 10 minutes.
- `MAIL_QUOTA`: wait 24 hours after completion (a conservative policy, not a
  provider-promised reset time). Old `MAIL_COMMAND_FAILED` records use the same
  delay because their discarded causes could have been quota failures.
- Authentication failure: block scheduled attempts until authorization is repaired
  and a manual sync succeeds; simply re-enabling does not clear the block.
- Other failures: exponential delay, 5 minutes up to 6 hours.
- Interrupted `syncing` record: wait at least an hour from its start and acquire
  the sync lock before retrying. A held lock still prevents another worker.

`jobs status` shows enablement, next eligibility time/reason, last attempt/phase,
and separate index status. An eligibility time is not a guarantee of immediate
execution: another account or manual operation can hold the global lock. Server
shutdown terminates its worker group; jobs resume eligibility checks after restart.
This is a persistent retry policy, not a durable execution queue with job IDs.

After each mbsync attempt has exited, the worker runs local indexing, **even after
quota errors or timeouts**. Download failures/cooldowns remain recorded separately
from successful indexing. If indexing also fails, inspect its separate diagnostic.
An abrupt kill can prevent this follow-up; a later attempt or `mailctl index` can
recover it. Limits remain 15 minutes for download and 5 minutes for indexing.

`mailctl index ALIAS` runs only notmuch under the global lock and records index
freshness without clearing download failures or cooldowns. Use it to register
previously manually indexed mail too. Search/read now work after a successful
local index, with `freshness` metadata and a conservative `partial` marker. Partial
results are not a complete Inbox audit, and even a completed sync is a local Inbox
archive, not live membership. Previously successful syncs remain searchable.
`MAIL_BUSY` means another operation owns the lock; wait rather than bypassing it.
OAuth refresh uses its own cross-process lock. `account status` exposes last attempt,
last success, and safe error codes. `RECONNECT_ACCOUNT` requires a fresh consent
flow. Subprocess/provider diagnostics are intentionally suppressed, not dumped into
chat or container logs. A killed sync may retain a `syncing` status and a short-lived
stale lock until the next run; inspect timestamps, never blindly remove active locks.

## Inspecting sync failures (diagnostic update)

```sh
mailctl diagnose personal
mailctl account status personal
# When a retry is appropriate, not while another worker is active:
mailctl sync personal --progress
```

`diagnose` is **local inspection only**: it makes no provider requests and starts
no sync. It returns the last recorded phase/failure and checks the global sync lock.
A held lock may belong to another account; it is not proof this account has a live
worker. `potentiallyInterrupted` flags a saved `syncing` record with no fresh lock,
not a guarantee that every old child process is gone. It never deletes locks.

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
records have no recoverable detail (`diagnosticAvailable: false`); no retroactive
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
- The wrapper currently limits **mbsync to 15 minutes** and **notmuch to 5 minutes**
  per account. Updated builds record the actual failure category and phase as
  described above; old deployed records only have `MAIL_COMMAND_FAILED`.
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
- [ ] Decide whether to expand beyond Inbox; Gmail labels/All Mail duplication,
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
