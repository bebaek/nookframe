# Queue a native restart

For the Linux existing-Pi **user** service `nookframe.service`, running Node directly (or via an `exec` wrapper) with the checkout as its working directory. Requires systemd, curl, npm and the same `XDG_RUNTIME_DIR` in both services. Set `Environment=NOOKFRAME_RESTART_PORT=...` in the helper unit if the app doesn't listen on loopback port 3000. Match the helper's `WorkingDirectory` to the checkout if not at `~/code/nookframe`.

One-time bootstrap from a **host terminal**, with chats and terminal tasks idle:

```sh
cd ~/code/nookframe
install -Dm644 scripts/nookframe-restart.service ~/.config/systemd/user/nookframe-restart.service &&
systemctl --user daemon-reload && npm run build && systemctl --user restart nookframe.service
```

After a code update, explicitly queue (including from a chat):

```sh
systemctl --user start --no-block nookframe-restart.service
```

Report **queued**, then finish the turn. Don't wait for the job from that chat. It blocks new prompts, waits up to ten minutes for loaded agents, builds, restarts, and checks an HTTP response from the replacement PID. systemd removes the private runtime marker directory on job exit, including failure or timeout. The helper does not pull code, install dependencies, monitor terminal subprocesses, or roll back build outputs. Close active web terminal tasks before queuing. If the build fails there is no restart. For failed startup, recover from a host terminal.

```sh
systemctl --user status nookframe-restart.service nookframe.service
journalctl --user -u nookframe-restart.service -n 40
```
