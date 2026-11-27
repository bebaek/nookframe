# Queue a native restart

For the Linux existing-Pi **user** service `nookframe.service`, running Node directly (or via an `exec` wrapper) with the checkout as its working directory. Requires systemd, curl, installed build dependencies in the checkout, and the same `XDG_RUNTIME_DIR` in both services. The helper runs `node --run build` with the running service’s Node executable; npm need not be on systemd’s `PATH`. Set `Environment=NOOKFRAME_RESTART_PORT=...` in the helper unit if the app doesn't listen on loopback port 3000. The installer sets the helper’s `WorkingDirectory` to the checkout. Use a systemd user drop-in for custom port settings.

The native existing-Pi installer prepares the helper when user systemd is available. For an existing installation, run this once from a **host terminal** (it does not restart the app):

```sh
cd ~/code/nookframe
make install-restart-helper
```

If the running service predates the restart probe, first run `npm run build && systemctl --user restart nookframe.service` from a host terminal with chats and terminal tasks idle. For routine code updates, explicitly queue from the checkout (including from a chat):

```sh
make restart
```

Report **queued**, then finish the turn. Don't wait for the job from that chat. It blocks new prompts, waits up to ten minutes for loaded agents, builds, restarts, and checks an HTTP response from the replacement PID. systemd removes the private runtime marker directory on job exit, including failure or timeout. The helper does not pull code, install dependencies, monitor terminal subprocesses, or roll back build outputs. Close active web terminal tasks before queuing. If the build fails there is no restart. For failed startup, recover from a host terminal.

```sh
systemctl --user status nookframe-restart.service nookframe.service
journalctl --user -u nookframe-restart.service -n 40
```
