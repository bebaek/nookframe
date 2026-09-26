# Pi Workspace

A single-user, persistent pi workspace with a mobile web chat. One Node server owns
one long-lived `pi --mode rpc` subprocess. Closing a browser does not stop a task.
No mail integration yet. 
## First run without containers

Requires Node.js 24+. Run these commands from this directory:

```bash
npm ci --ignore-scripts
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
The token is sent as the first WebSocket message, never in a URL, and remains only
in browser memory. Refreshing the page requires signing in again. Transient
network disconnects reconnect automatically. Use your editor/password manager to
read/store the token; don't commit it or put it into logs.

Try: **“Create hello.txt in the current workspace containing hello from pi.”**
The default workspace is `.local/workspace`, not this application's source tree.
For frontend changes, rebuild with `npm run build`; `npm run dev` runs only the
TypeScript backend against already-built frontend assets.

Local execution is **not sandboxed**: pi runs as your host user. Prefer the
container before enabling integrations or handling untrusted content.

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
| `AGENT_PROVIDER`, `AGENT_MODEL` | Optional paired override: provider plus exact model ID; locks the web selector |

Use an HTTPS reverse proxy with WebSocket upgrade support before remote access.
Set `PUBLIC_ORIGIN` to the exact HTTPS origin and persist workspace and application
data. For Kubernetes, use one replica with `Recreate`, disable automounted service
account credentials, and provision the access token through a private secret
management system. Keep cluster manifests and operational runbooks outside this
repository; the application does not apply cluster resources.

## Behavior and scope

- One fixed session ID, `workspace`, with normal read/bash/edit/write tools.
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
- The web **Model** selector uses pi's available model catalog. Changes are allowed
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
  Slash commands, extension dialogs, uploads, terminal emulation, session switching,
  steering/follow-up controls, and file browsing are intentionally deferred.
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
A successful real-model task and Podman volume
replacement test are still required before calling this deployment validated.
