---
name: operations
description: Inspect this Nookframe instance and safely change a conversation model or the default for newly created conversations through authenticated, scoped model plans.
---

# Nookframe operations

Use `nookctl status`, `nookctl config`, and `nookctl sessions` for self-inspection. Commands return JSON and read `ACCESS_TOKEN_FILE` internally. Never read or print that file yourself, include its contents in commands, or ask the user to paste credentials.

- `status`: slot, process uptime, and capability flags; not an end-to-end health check.
- `config`: `model` describes the legacy fallback for existing unpinned threads; `newThreads` describes the default for explicitly newly created threads on this instance. Neither describes every running conversation. Null means Pi chooses; do not invent a model.
- `sessions`: loaded agents on this instance only, not all saved threads or other slots. Does not start agents or expose messages.

## Model changes

Only change settings when the user requests them. Clarify whether they mean this conversation or new conversations if scope is ambiguous. Plans are authenticated commands, not independent proof of human approval.

1. Identify the exact thread. The current agent's `NOOKFRAME_PRESENCE_THREAD_ID` identifies its own thread when available; otherwise use the loaded-session inventory and ask if ambiguous. Do not guess a thread from a title.
2. Run `nookctl models THREAD` to discover exact provider/model IDs and current settings. The thread must be loaded and owned by this instance. Do not open arbitrary conversations merely to discover models.
3. Prepare the exact change:
   - Idle thread: `nookctl model-plan thread THREAD PROVIDER MODEL`
   - New conversations only: `nookctl model-plan new-threads THREAD PROVIDER MODEL`
   - This running conversation: `nookctl model-plan-after-run THREAD PROVIDER MODEL`
4. Inspect the returned before/after values, scope, revision, expiration and deferral. If consistent with the user's explicit request, apply that exact ID using `nookctl model-apply PLAN`. If approval is ambiguous, present the proposal and ask first.
5. Read the result with `nookctl model-result PLAN`. Only `applied` confirms success. `pending` means scheduled after this run settles; tell the user that it has not switched yet. Do not keep polling from the same run: it cannot settle while you are still working. Confirm on the next request using the saved plan ID or model inventory.

`nookctl model-cancel PLAN` cancels a proposed or pending change before dispatch. It cannot cancel a change already applying. Repeated apply calls for the same ID return its existing status instead of repeating the mutation. Stale, expired, environment-locked, unavailable, and background-only targets are rejected. Plans expire after 30 minutes and are not replayed across server restarts. If the result is `uncertain`, inspect actual state; never automatically prepare a replacement change.

Changing a new-thread default does not affect existing threads, even when reopened. It applies on this instance, not automatically to every slot. The current thread is used only to validate the model catalog for that operation.

Job control, diagnostics/log access, and deployments are not supported here. Do not substitute ad hoc file edits for unsupported operations. Report failures honestly.

The CLI defaults to loopback and `PORT` (3000). `NOOKFRAME_API_URL` explicitly selects another server; remote URLs require HTTPS. Identify the returned slot before making claims about an instance.
