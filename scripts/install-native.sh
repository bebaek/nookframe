#!/usr/bin/env bash
# Build an existing, trusted checkout. Never downloads or executes remote scripts.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
mode=--token
pi_mode=existing
for arg in "$@"; do
  case "$arg" in
    --token|--local) mode="$arg" ;;
    --isolated) pi_mode=isolated ;;
    *) printf 'Usage: bash scripts/install-native.sh [--token|--local] [--isolated]\n' >&2; exit 2 ;;
  esac
done
if [[ "$pi_mode" == existing ]]; then
  pi_bin="${NOOKFRAME_PI_BIN:-$(command -v pi || true)}"
  if [[ -z "$pi_bin" ]]; then
    printf 'Pi not found. Install Pi 1.5.0 or set NOOKFRAME_PI_BIN; use --isolated for a separate profile.\n' >&2
    exit 1
  fi
fi
for tool in node npm python3 make c++; do
  command -v "$tool" >/dev/null || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ required"); process.exit(1); }'
if [[ -e .local/start || -L .local/start ]]; then
  printf '.local/start already exists; inspect it before reinstalling. Nothing changed.\n' >&2
  exit 1
fi
npm ci --include=dev --ignore-scripts
npm rebuild node-pty --foreground-scripts
npm run check
npm run build
if [[ "$pi_mode" == existing ]]; then
  NOOKFRAME_PI_BIN="$pi_bin" node --input-type=module -e 'import {existingPiRuntime} from "./dist/server/existing-pi.js"; existingPiRuntime(process.env);'
fi
umask 077
mkdir -p .local/workspace .local/state
if [[ "$pi_mode" == isolated ]]; then mkdir -p .local/agent; fi
if [[ "$mode" == --token && ! -e .local/access-token ]]; then
  node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(".local/access-token", randomBytes(32).toString("hex"), {mode: 0o600, flag: "wx"});'
fi
# %q safely quotes checkout paths, including spaces and shell metacharacters.
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\ncd -- %q\n' "$PWD"
  printf 'export HOST=127.0.0.1\nexport PORT="${PORT:-3000}"\nexport PUBLIC_ORIGIN="http://localhost:$PORT"\nunset ALLOWED_ORIGINS\n'
  printf 'export NOOKFRAME_PI_MODE=%q\n' "$pi_mode"
  if [[ "$pi_mode" == isolated ]]; then
    printf 'export PI_CODING_AGENT_DIR="$PWD/.local/agent"\n'
  else
    printf 'if [[ -z "${NOOKFRAME_PI_BIN:-}" ]]; then export NOOKFRAME_PI_BIN=%q; fi\n' "$pi_bin"
    printf 'if [[ -z "${PI_CODING_AGENT_DIR:-}" ]]; then export PI_CODING_AGENT_DIR=%q; fi\n' "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
    if [[ -n "${PI_CODING_AGENT_SESSION_DIR:-}" ]]; then
      printf 'if [[ -z "${PI_CODING_AGENT_SESSION_DIR:-}" ]]; then export PI_CODING_AGENT_SESSION_DIR=%q; fi\n' "$PI_CODING_AGENT_SESSION_DIR"
    fi
  fi
  printf 'export STATE_DIR="$PWD/.local/state"\nexport WORKSPACE_DIR="${WORKSPACE_DIR:-$PWD/.local/workspace}"\n'
  if [[ "$mode" == --local ]]; then
    printf 'export NOOKFRAME_LOCAL_ACCESS=1\nunset ACCESS_TOKEN_FILE\n'
  else
    printf 'export NOOKFRAME_LOCAL_ACCESS=0\nexport ACCESS_TOKEN_FILE="$PWD/.local/access-token"\n'
  fi
  printf 'exec node dist/server/main.js\n'
} > .local/start
chmod 700 .local/start
if [[ "$pi_mode" == isolated ]]; then
  printf '\nLog in with:\n  PI_CODING_AGENT_DIR="$PWD/.local/agent" ./node_modules/.bin/pi\n'
else
  printf '\nUses your existing Pi profile and sessions (npm Pi 1.5.0 required). No separate login.\nWARNING: Close terminal Pi before opening a shared chat. Stop Nookframe before resuming it in Pi. Closing a browser tab is NOT a handoff.\n'
fi
printf '\nRun .local/start and open http://localhost:3000\n'
if [[ "$mode" == --local ]]; then
  printf 'WARNING: Tokenless local access trusts all local users. Do not proxy, tunnel, or port-forward this listener.\n'
else
  printf 'Read .local/access-token privately in your editor for browser sign-in.\n'
fi
