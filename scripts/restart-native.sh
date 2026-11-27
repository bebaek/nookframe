#!/usr/bin/env bash
# Run only from the independent oneshot, not from the application service.
set -euo pipefail
unit=nookframe.service
port=${NOOKFRAME_RESTART_PORT:-3000}
[[ $port =~ ^[0-9]+$ && ${RUNTIME_DIRECTORY:?} == "${XDG_RUNTIME_DIR:?}/nookframe-restart" ]]
pid() { systemctl --user show "$unit" -p MainPID --value; }
old=$(pid)
[[ $old =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$old/cwd") == "$PWD" ]]
# Match the running service's Node version, including nvm installations.
node_bin=$(readlink -e "/proc/$old/exe")
export PATH="$(dirname "$node_bin"):$PATH"
probe() { curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/healthz/restart"; }
touch "$RUNTIME_DIRECTORY/$old"
echo 'Waiting for active chat turns to finish before building'
until [[ $(probe) == "$old:idle" ]]; do
  [[ $(pid) == "$old" && $SECONDS -lt 600 ]] || { echo 'Drain failed; not restarting' >&2; exit 1; }
  sleep 1
done
echo 'Building with the running service’s Node runtime'
"$node_bin" --run build
[[ $(pid) == "$old" && $(probe) == "$old:idle" ]]
systemctl --user restart "$unit"
new=$(pid)
[[ $new =~ ^[1-9][0-9]*$ && $new != "$old" ]]
touch "$RUNTIME_DIRECTORY/$new"
deadline=$((SECONDS + 60))
until [[ $(probe) == "$new:idle" ]]; do
  [[ $(pid) == "$new" && $SECONDS -lt $deadline ]] || { echo 'Restart readiness failed' >&2; exit 1; }
  sleep 1
done
echo 'Replacement server is listening and ready'
