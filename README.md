# Pi Workspace

A single-user, persistent pi workspace with mobile web chat and a private terminal tab. One Node server owns
one long-lived `pi --mode rpc` subprocess. Closing a browser does not stop a task.
Includes an optional read-only Gmail/IMAP CLI and chat-discoverable mail skill.

## First run without containers

Requires Node.js 24+, Bash, Python 3, make, and a C++ compiler (for node-pty).
Run these commands from this directory:

```bash
npm ci --ignore-scripts
npm rebuild node-pty --foreground-scripts
npm run build
mkdir -p .local
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync(".local/access-token", randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })'
```

Set up a **dedicated** pi profile (do not mount/copy your entire home directory).
For subscription/OAuth login, start the installed CLI and use `/login`, choose a
model, then exit. Alternatively supply a supported provider API-key environment
variable when starting the server.

```bash
PI_CODING_AGENT_DIR="$PWD/.local/agent" ./node_modules/.bin/pi
ACCESS_TOKEN_FILE="$PWD/.local/access-token" npm start
```

Open **http://localhost:3000**, then paste the token from `.local/access-token`.
The token is submitted once to the same-origin login endpoint, never in a URL.
A separate opaque HttpOnly cookie keeps this browser signed in for 30 days,
including across page reloads and server/container replacements. The app does not
store the access token in localStorage or sessionStorage. Transient disconnects
reconnect automatically. Use your editor/password manager to read/store the token;
don't commit it or put it into logs.

Try: **“Create hello.txt in the current workspace containing hello from pi.”**
The default workspace is `.local/workspace`, not this application's source tree.
For frontend changes, rebuild with `npm run build`; `npm run dev` runs only the
TypeScript backend against already-built frontend assets.

Local execution is **not sandboxed**: pi runs as your host user. Prefer the
container before enabling integrations or handling untrusted content.

## Browser sign-in

- Sign in once per browser with the existing access token. An upgrade from the
  old memory-only login needs one final sign-in to establish the cookie.
- Cookie: HttpOnly, SameSite=Strict, fixed 30-day expiry, host-only and Secure on
  HTTPS (`__Host-` prefix). HTTP localhost development uses a non-Secure cookie.
- Only hashes of randomly generated browser credentials are persisted, atomically,
  in `$STATE_DIR/browser-sessions.json` (`/data/state` in the container). Keep this
  directory persistent. Up to 64 logins are retained; the oldest is evicted beyond
  that limit. Never log cookie values or login request bodies.
- **Sign out**, inside **⋯ Workspace controls**, revokes this browser login server-side, clears its cookie, and closes
  associated chat/terminal connections across tabs. Other browsers remain signed
  in. Agent tasks and the shared shell continue running; signing out is not Stop.
- Rotating the web access token and restarting the server invalidates all browser
  logins. Removing the session-store file while the server is stopped also revokes
  them. A backup restore can restore previously revoked entries; rotate the access
  token after a security-related restore.
- Login/logout require the exact configured Origin; WebSockets retain the same
  origin check and authorize before sending data or opening a shell. Browsers send
  an auth frame without the token; trusted CLI clients can still use token frames.
- Use only trusted devices. Cookies confer shell-equivalent access even though
  JavaScript cannot read them. Private browsing, clearing cookies, expiry, or token
  rotation requires signing in again.

## Chat layout and threads

Chat uses one compact header for Chat/Terminal tabs, connection status, and the
**⋯ Workspace controls** menu. Open that menu for Thread, New thread, Model, and
Sign out; it overlays the transcript rather than shrinking it. Close with its
close button, Escape, or a click outside. A small context line identifies the
active thread/model. The composer starts at one line, grows up to 144px, and keeps
Send alongside it; Stop appears while working. Tool output starts collapsed,
including running tools, and reading earlier messages prevents auto-scroll.
The layout uses the browser's native Popover API (current Chrome/Safari/Firefox).

Inside **⋯**, use **Thread** to resume a conversation or **New thread** for a blank one.
Each thread has its own pi JSONL history; all threads share workspace files,
credentials, and one agent process. Thread titles come from the first user message
(or an existing pi session name). Switching itself makes no model request.

- Only one web thread is active at a time, shared across browsers. Finish or stop
  a task before switching; model/thread changes and prompts are serialized.
- Commands carry the expected thread ID. A stale browser cannot accidentally send
  a prompt into a thread selected by another browser.
- Drafts are kept separately per thread in that browser's memory; refreshing clears
  drafts. Switching does not move an unsent draft into a different conversation.
- The last selection is saved atomically in `$STATE_DIR/active-thread.json`.
  Empty threads get a header-only JSONL file, so they survive restart without
  synthetic messages or an initial model call.
- The existing `workspace` conversation is selected on first upgrade; its file is
  retained. Subsequent starts restore the saved selection. Missing/corrupt saved
  selections fail closed rather than silently opening another conversation.
- The web's saved model/environment override remains in effect when resuming old
  threads. Without a configured choice, pi's normal session model behavior applies.
- The picker only includes the server-owned `workspace-sessions` directory, not
  independent terminal pi sessions. No delete, fork, or in-thread branch UI yet.
- Include these sessions and the active-selection file in your private backups.

## Terminal tab

After signing in, select **Terminal**. This opens one shared Bash PTY in the
workspace, independent of chat/RPC. Run `pi` for the interactive TUI and `/login`.
Pi uses the same provider credentials, but a normal new CLI session rather than
the chat's selected web session. Do not explicitly open/resume the chat
session in another pi process. There is no maintenance mode or automatic restart;
concurrent commands/agents can edit the same files or refresh credentials.

- The shell starts lazily, survives tab switches and browser disconnects, and is
  shared by all authenticated terminal connections (not separate user sessions).
- Refreshing restores the browser login, then reattaches to the running shell.
  There is **no server-side terminal replay**: disconnected output is discarded.
  A forced resize requests a TUI redraw on attachment; Ctrl+L redraws a shell.
  This is not a terminal multiplexer: programs may not reconstruct earlier output.
- `exit` ends the shell; **New shell** starts another. Container restarts, deploys,
  and any maintenance shutdown end all terminal processes.
- Terminal transport uses the same browser session/origin checks as chat, a separate
  WebSocket path, heartbeat, payload limits, and bounded socket buffering.
- The app neither logs terminal input/output nor sends it into chat/model context.
  Bash startup files are skipped and shell history is disabled. Programs launched
  inside it can still save their own history, sessions, or logs. Use `/login` or
  masked credential prompts, not a pi chat prompt, for secret entry.
- The browser holds terminal scrollback only in memory. **Clear screen** clears
  its visible scrollback, not data retained by terminal programs or other clients.
- This is private entry, **not credential isolation**: the agent still has the
  same filesystem permissions and can read saved credentials.
- Mobile buttons provide arrow keys (including application-cursor mode for TUIs),
  Esc, Tab, Ctrl+C/D/L, and Paste (requires browser
  clipboard permission). Pasting more than 16000 characters is rejected.

Credential changes may need a manual server restart to refresh the RPC model
catalog. Terminal pi model selection does not update the web's saved selection.

## Read-only mail

The image includes `mailctl`, mbsync, notmuch, and a Gmail XOAUTH2 helper. A bundled
pi skill guides account connection through chat: a Google authorization link goes
to the user; the callback exchanges/stores credentials without exposing them in
chat. Enter the one-time Google web OAuth client configuration privately with
`mailctl oauth configure` in Terminal. Nothing connects or syncs by default.

Start with one account, then opt into persistent retry jobs with
`mailctl jobs enable ALIAS`; inspect or pause them with `jobs status` / `jobs pause`.
Jobs use error-specific cooldowns and index local mail after failed downloads too.
`mailctl index ALIAS` makes existing downloads searchable without contacting Google.
Search and read commands return bounded, explicitly untrusted email data with
freshness and partial-index markers. No sending, remote flag updates,
remote deletes, or expunge. Gmail's OAuth scope is nevertheless broad, and the
shared agent filesystem is not a credential sandbox.

See [mail setup, Google consent requirements, limits, and trust model](mail/README.md).
The first account has completed real Google consent and begun IMAP downloading.
Its initial chat-driven sync timed out; use `mailctl sync ALIAS` in private Terminal
for future large first downloads, not raw mbsync. Terminal avoids the chat timeout
but not the wrapper's 15-minute download/5-minute indexing limits.
See the [known gaps and acceptance checklist](mail/README.md#known-gaps-and-acceptance-checklist)
for remaining liveness reconciliation, cancellation/progress work, and real-mail validation.
Mail content, credentials, and indexes persist in `/data/mail`; include that
location in your private backups. Review storage/staging capacity before
downloading a large Inbox.

## Rootless Podman

Podman is not required by the application itself. No Docker/Podman socket is mounted.

For a current, system-wide Podman on Ubuntu/Pop!_OS 24.04 amd64, review and run:

```bash
less scripts/setup-podman.sh
sudo bash scripts/setup-podman.sh
# Run these as your normal user, not root:
podman info
podman run --rm docker.io/library/alpine:latest echo "Podman works"
```

The script uses the **third-party Alvistack OBS repository**, not an official
Ubuntu or Podman package source. It checks the signing-key fingerprint, uses a
repository-specific `signed-by` keyring, and pins only an explicit list of
container packages; all other packages from that repository are blocked. It
previews the plan, rejects package removals, and asks for APT confirmation.
The key fingerprint is pinned from the publisher's HTTPS endpoint, not an
independent identity attestation. Signing-key rotation requires manual review.

### Configuration-package migration

Alvistack's `containers-common` can overlap Ubuntu's
`golang-github-containers-common` and `golang-github-containers-image` without
declaring the replacement. The setup script stops if either is installed. Back up
`/etc/containers` privately and review package ownership, reverse dependencies,
and the replacement order before migrating. An APT simulation may not detect
file collisions. Do not use `--force-overwrite`, `--force-depends`, or blindly
replace custom registry/signature policies.

Each host user needs separate, non-overlapping `/etc/subuid` and `/etc/subgid`
allocations. Rootless container storage is per-user. Verify `podman info` reports
rootless operation and storage locations owned by the intended user. If explicit
configuration is needed, use that user's home and runtime directories in
`~/.config/containers/storage.conf`; do not copy another user's paths. Check for
existing containers and images before changing storage locations. Do not delete
or re-own root storage to work around a rootless configuration problem.

APT configuration files created by the script:

- `/etc/apt/sources.list.d/alvistack-podman.sources`
- `/etc/apt/preferences.d/alvistack-podman`
- `/etc/apt/keyrings/alvistack-podman.gpg`

Canceling installation leaves this repository configured. Remove these three
files and run `sudo apt update` to disable it. This **does not downgrade installed
packages**: Alvistack uses version epoch `100:`, so reverting after installation
needs a separately reviewed, coordinated downgrade of the container packages.
Do not run `apt autoremove` or downgrade a live container stack blindly.

```bash
podman build -t localhost/pi-workspace:dev -f Containerfile .
podman volume create pi-workspace-files
podman volume create pi-workspace-data
podman secret create pi-workspace-token .local/access-token
```

Initialize the container's dedicated pi credentials interactively. The data
volume is the same one used by the server; select your model and use `/login`:

```bash
podman run --rm -it \
  -v pi-workspace-data:/data \
  --entrypoint /app/node_modules/.bin/pi \
  localhost/pi-workspace:dev
```

Run the web workspace:

```bash
podman run --name pi-workspace --rm \
  -p 127.0.0.1:3000:3000 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=256 --memory=2g --cpus=2 --stop-timeout=20 \
  -v pi-workspace-files:/workspace \
  -v pi-workspace-data:/data \
  --secret pi-workspace-token,target=access-token,uid=1000,mode=0400 \
  -e ACCESS_TOKEN_FILE=/run/secrets/access-token \
  -e PUBLIC_ORIGIN=http://localhost:3000 \
  localhost/pi-workspace:dev
```

Use `podman stop pi-workspace` to shut down. Start the same command again to
restore the session and files. Do not run two containers against the same volumes.
Named volumes are retained when the container is removed. The server locks its pi
profile against a second server; after an unclean kill the stale lock may take
30 seconds to become reclaimable. Only `/workspace` and
`/data` persist; bake additional installed software into `Containerfile`.

The image runs as UID/GID 1000. Named volumes initialize from image directories;
existing bind mounts instead need ownership mapped for rootless Podman's user
namespace. Don't use `chmod 777` as a workaround.

## Configuration

| Variable | Default / purpose |
|---|---|
| `ACCESS_TOKEN_FILE` | Required; random access token, at least 32 characters |
| `PUBLIC_ORIGIN` | `http://localhost:3000`; exact browser origin allowed for WebSockets |
| `HOST` | `127.0.0.1` locally; `0.0.0.0` in image |
| `PORT` | `3000` |
| `WORKSPACE_DIR` | `.local/workspace`; `/workspace` in image |
| `PI_CODING_AGENT_DIR` | `.local/agent`; `/data/agent` in image |
| `STATE_DIR` | `.local/state`; `/data/state` in image |
| `MAIL_DIR` | Sibling `mail` directory beside `STATE_DIR`; `/data/mail` in image |
| `AGENT_PROVIDER`, `AGENT_MODEL` | Optional paired override: provider plus exact model ID; locks the web selector |

Use an HTTPS reverse proxy with WebSocket upgrade support before remote access.
Set `PUBLIC_ORIGIN` to the exact HTTPS origin and persist workspace and application
data. For Kubernetes, use one replica with `Recreate`, disable automounted service
account credentials, and provision the access token through a private secret
management system. Keep cluster manifests and operational runbooks outside this
repository; the application does not apply cluster resources.

## Behavior and scope

- One active web thread with normal read/bash/edit/write tools; multiple persisted
  conversations can be selected without spawning extra agent processes.
- Pi's JSONL session is authoritative; the bridge only keeps a bounded live view.
- Reconnects receive a replacement snapshot, including current streaming text
  and tool activity. Commands are **never automatically retried** after disconnect.
- The UI displays the last 200 messages on the active branch. Long content is
  truncated for display; the underlying session retains normal pi output.
- Stop clears the queue before aborting. Cancellation does not undo shell effects.
- A disk marker warns about interrupted runs after restart. It is not a job queue
  or checkpoint engine. Partial model output may be lost on process termination.
- Pi defers writing a brand-new session until the first assistant message. A crash
  before that point can leave no transcript; the interruption warning still works.
- An RPC failure makes the bridge unavailable; inspect/restart rather than silently
  resubmitting possibly accepted work. `/healthz` then reports 503.
- The **Model** selector in **⋯ Workspace controls** uses pi's available model catalog. Changes are allowed
  only while idle, applied through RPC, and atomically saved in
  `$STATE_DIR/model.json` (container: `/data/state/model.json`). The active model is
  shown in the header and shared across browser tabs. Switching does not send a
  model request or clear conversation history.
- Model precedence: paired `AGENT_PROVIDER` + `AGENT_MODEL` environment override →
  saved web choice → pi's saved default. With no configured choice/default, pi
  uses its normal startup/session selection. Exact configured IDs are validated;
  an unavailable saved choice fails startup rather than silently using another
  model. Provider authentication still uses the pi CLI; restart after changing
  credentials to refresh the available catalog.
- Environment overrides lock the selector and are labeled in the UI. Remove both
  variables and recreate the container to enable web selection. An override does
  not replace an existing saved web preference. To reset a stale preference, stop
  the server and back up/remove only `$STATE_DIR/model.json`, then restart.
- Extensions are disabled and project-local trust-gated resources are ignored.
  The bundled mail skill is explicitly loaded despite those restrictions.
  In web chat, slash commands, extension dialogs, uploads, in-session branching,
  steering/follow-up controls, and file browsing are intentionally deferred.
  Interactive terminal pi is independent and uses its normal CLI behavior.
- Plain text rendering only: model output and tool results are never injected as HTML.

## Trust model

**The web token grants shell-equivalent access inside this container.** Pi can read
its credentials, alter its workspace, and make outbound network requests. A
non-root container limits host exposure but does not isolate credentials from the
agent. Prompt instructions or future approval cards cannot prevent shell bypass.
Do not mount host home directories, SSH keys, container sockets, or kubeconfigs.
Do not expose this MVP publicly. It is not a multi-user system.

Emails/web pages/files can contain malicious instructions. Only add sensitive
integrations after deciding what credentials and network access this workspace
should have. Hosted model providers receive the content sent to them. Protect
both volumes and backups: sessions can contain sensitive text and `/data/agent`
contains provider credentials. The token file is likewise readable by the agent
under this deliberately single-user trust model.

## Validation

```bash
npm run check
npm run build
npm test
npm run test:rpc
# Install a Playwright browser once, or supply your existing Chrome executable:
npx playwright install chromium
npm run test:browser
# Alternative: BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:browser
npm audit
# Build the image first, then test it with disposable scratch mounts and no credentials:
TEST_IMAGE=localhost/pi-workspace:dev BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:container
TEST_IMAGE=localhost/pi-workspace:dev npm run test:mail-container
```

Unit/integration tests cover token/origin validation, reconnects during an active
run, concurrent-run rejection, stream reconstruction, stop, and interruption
markers. The RPC smoke test runs the actual pinned pi CLI, executes a harmless
shell command to write a file, and verifies restoration after replacing the pi
process. It seeds a synthetic assistant turn to enable session persistence and
makes **no model/API calls**. The browser smoke test uses a fake agent and exercises
a 390×844 mobile viewport, model selection, sending, draft acknowledgement,
reload/reconnect while working, and stop. Model tests cover persistence across
controllers, precedence, environment locking, concurrent-operation rejection,
unavailable choices, RPC failures, and persistence failures; its screenshot goes to ignored `.local/mobile-smoke.png`.
Terminal tests cover authentication/origin rejection, shell state across reconnects,
resize validation, exit/restart, and separation from chat snapshots. The browser
smoke also runs a real Bash PTY and offline pi TUI at phone size; its screenshot is
`.local/terminal-mobile-smoke.png`. No real provider credentials are used in tests.
Run container smoke tests and verify persistence before production rollout.
Thread tests cover legacy migration, empty-thread persistence, separate histories,
model precedence, unsafe paths, concurrent switches, stale clients, and failed
switch/save recovery. The real RPC smoke restarts into an empty selected thread;
the two-browser mobile test exercises shared selection and isolated drafts. Its
screenshot is `.local/threads-mobile-smoke.png`.
Browser-auth tests cover cookie flags, no JavaScript/localStorage credential access,
page reload and server replacement without another login, cross-tab sign-out,
persisted revocation, expiry, access-token rotation, CSRF rejection, and failed
session-store writes.
Mail tests cover state/PKCE, callback privacy, credential permissions, masked TTY
entry, refresh and revoked grants, scope checks, account identity, safe status,
locks, and bounded untrusted message projection. The offline mail-container test
runs real TLS/XOAUTH2 mbsync against a disposable IMAP server, rejects write commands,
checks BODY.PEEK, and verifies real notmuch searches/read output with duplicate
messages and independent unread state across two accounts. No Gmail access occurs.
