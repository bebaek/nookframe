# Development and homelab administration

The runtime image also serves as a trusted personal workstation. It includes
Git, GitHub CLI, SSH, Node/npm, Python/PyYAML, make/g++, pkg-config, ripgrep, jq,
rsync, age, SOPS, kubectl, and Chromium. Standalone kubectl and SOPS binaries are
version- and checksum-pinned for the currently published linux/amd64 image.

## Persistent state

Deployments should persist `/workspace` and `/home/node` as well as application
state under `/data`. The homelab mounts `/data/home` at `/home/node`; both slots
share that home and the checkouts under `/workspace/code`. Keep credentials out
of images, Git, prompts and tool output. Restrict home and credential permissions
and ensure encrypted backups cover them. Never attach an entire host home or a
container runtime socket just to provide development tools.

This is deliberately a **trusted admin environment**. If GitHub credentials,
SSH keys, SOPS keys and an admin kubeconfig are provisioned, the agent can exercise
those permissions. Application compromise or malicious tool instructions can
therefore affect the homelab. Keep external SSH and cluster credentials usable
independently of Nookframe. The pod still runs non-root with a read-only root
filesystem, no service-account token, and no elevated Linux capabilities.

## Working in a checkout

```bash
cd /workspace/code/nookframe
npm ci --include=dev
npm rebuild node-pty --foreground-scripts
npm run check
npm run build
npm test
npm run test:browser
```

All `npm test` / `npm run test:*` entry points now launch tests through
`scripts/run-tests.mjs`. The launcher allowlists only tooling/environment basics,
uses a temporary home, temp directory and XDG directories, and does not inherit
application directories, provider keys, admin credentials or `NODE_OPTIONS`.
Fixture subprocesses inherit that isolated environment. The launcher propagates
exit status, forwards interruption signals, and cleans up after completion,
failure or handled interruption (SIGKILL cannot be cleaned up).

This prevents accidental live-state access such as a fixture CLI inheriting
`GOOGLE_DIR=/data/google`. It is **not a sandbox**: test code can still explicitly
open `/data` or use network access. Avoid direct `tsx --test` / `node --test`
invocations in a live pod because those bypass the launcher. For a focused test:

```bash
node scripts/run-tests.mjs test/mail.test.ts
```

Browser binaries use the existing Playwright cache or configured system Chromium,
not the disposable home. Container smoke tests use an explicit `--container` mode:
the test process remains isolated, while `containerEnvironment()` restores the
original Docker/Podman storage/config paths **only for runtime invocations**.
This retains local image discovery and registry configuration without passing
live Nookframe state variables into test subprocesses. Container runtime access
is privileged by design; do not treat those tests as untrusted code.

The application image sets `NODE_ENV=production`; explicitly include dev
dependencies when installing a checkout. `BROWSER_EXECUTABLE_PATH` points to
system Chromium and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` avoids duplicate browser
downloads. Browser smoke tests already honor that executable override. Building
native dependencies is supported by the included compiler and Python.

For the homelab checkout, use its documented lint, manifest rendering and tests.
`kubectl`, `gh`, `ssh`, `sops`, and `age` use ordinary persistent home configuration.
Kubernetes deployments explicitly set `KUBECONFIG` to the provisioned admin file;
there is no automatic fallback to an in-cluster service-account credential.

Use one shared checkout from one instance at a time. For simultaneous work, use
separate Git worktrees and branches; do not run concurrent Git/index operations
or dependency installs in one checkout. Chat/session concurrency is a separate
[known limitation](session-concurrency.md).

## Builds and deployment

Push branches and use PRs and GitHub Actions to build and publish release images.
Container-image builds/tests still run on the host or CI; no Docker/Podman daemon
or sudo is provided inside Nookframe.

Homelab slot commands inspect `NOOKFRAME_SLOT` (injected by Kubernetes) and reject
redeploying that same slot. They also refuse to replace the slot serving the main
URL. This protects ordinary workflows, not hostile commands: admin credentials
can bypass the helper. After promotion, refresh/reconnect to the other instance
before deploying the one you were using. A raw `kubectl apply` can still restart
your own pod. Cluster-wide changes and backup jobs can also interrupt both slots.
