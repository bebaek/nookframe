# Operations API

The API reuses the existing browser session or `Authorization: Bearer <existing access token>`. No new credential is introduced. Requests carrying an Origin must match the existing allowed-origin policy. Cookie-authenticated writes additionally require an explicit allowed Origin. Requests and responses are not logged, responses are not cacheable, and errors omit exception contents.

## Inspection

`GET /api/operations/{status,config,sessions}`:

- **status**: schema version, slot, process uptime and capability flags, not dependency health.
- **config**: `model` is the legacy fallback (environment > saved > Pi) for existing unpinned threads. `newThreads` is the new-thread-only default, its source, revision, and environment lock status. An unspecified Pi model remains null.
- **sessions**: loaded agents on this instance, bounded by capacity, including runtime model/source, busy/available state, viewer references and ownership. No messages, prompts, titles, tool output or history; no cross-slot inventory. Reading does not acquire an agent.

Use `nookctl status|config|sessions` in the image, or `npm run ops -- status` in a checkout. The CLI reads `ACCESS_TOKEN_FILE`, defaults to `http://127.0.0.1:${PORT:-3000}`, and accepts an explicit `NOOKFRAME_API_URL` origin. Remote origins require HTTPS; redirects are refused and requests time out after ten seconds. Never pass tokens in arguments.

## Scoped model plans

```
nookctl models THREAD
nookctl model-plan thread THREAD PROVIDER MODEL
nookctl model-plan new-threads THREAD PROVIDER MODEL
nookctl model-plan-after-run THREAD PROVIDER MODEL
nookctl model-apply PLAN
nookctl model-result PLAN
nookctl model-cancel PLAN
```

Corresponding routes:

- `GET /api/operations/models?threadId=...`: the loaded thread's catalog, model/revision and new-thread defaults.
- `POST /api/operations/models/plans`: JSON `{scope: "thread" | "new-threads", threadId, model: {provider, id}, deferUntilSettled?: boolean}`.
- `GET /api/operations/models/plans/ID`: process-local plan status.
- `POST /api/operations/models/plans/ID/apply`: empty JSON object; apply the exact proposal.
- `POST /api/operations/models/plans/ID/cancel`: empty JSON object; cancel before dispatch only.

Mutation bodies are limited to 4 KiB and require JSON. Invalid/unsupported proposals return a sanitized 409. Apply returns the plan outcome; a 200 does not imply `applied`. Plans record exact before/after values, scope, target, revision, expiry and requester transport (`browser` or `token`). These are shared-owner authenticated commands, not independent human approval or per-user identity. The skill requires a user request and scope clarification when ambiguous. Existing shell access is still a separate trust boundary.

### Thread scope

The target must already be loaded, available, non-background and owned by this instance. Available models come from that agent's catalog. The existing Workspace setter handles RPC activation, read-back verification and persistence. WebSocket model changes also advance the revision, so an intervening change (even A → B → A) invalidates a plan. Replacing the agent invalidates its plans. Busy changes are rejected unless deferral was explicitly proposed. A deferred change executes only once the run settles and takes the same synchronous model-change guard before another prompt can start; `agent_end` is not sufficient.

### New-thread scope

The selected model is atomically stored in `STATE_DIR/new-thread-model.json`, under a cross-process write lock and revision check. Only explicitly creating a new thread consumes it; an existing unpinned thread still uses the legacy fallback. A new thread snapshots its explicit default into its existing per-thread model preference before startup, so later default changes do not affect it when reopened or moved to another slot. Environment overrides win and block mutations. This default is scoped to the instance's state directory, not a global fleet setting. The initial bootstrap thread is treated as existing; use New thread to consume the new default.

### Outcomes and recovery

States are `proposed`, `pending`, `applying`, `applied`, `rejected`, and `uncertain`. Retry the same apply ID only to retrieve its status, never to dispatch twice. A timeout is not proof of failure; inspect the plan and current model. Only `applied` confirms success. A pending change requested from its own conversation cannot settle until that conversation's run ends; the agent must report it as pending rather than poll forever.

Plans expire after 30 minutes; at most 200 are retained per server process. Private per-plan audit snapshots are stored in `STATE_DIR/model-operations/`, excluding prompts and credentials. Intent is persisted before dispatch and outcome afterward. Audit failures or ambiguous RPC outcomes fail closed as uncertain. Audit snapshots are not an executable queue: restart never replays them, and IDs from a previous process cannot be applied or queried through this process-local API. Inspect state and audit files administratively after a crash. Clean shutdown rejects pending plans; cancellation cannot undo an already dispatched change. Rollback is a new checked proposal, not a blind file restore.

## Deferred

Job controls, redacted diagnostics, build identity, per-user authorization, independent human-approval UI, audit-history browsing/retention, and deployment adapters remain future increments. Existing UI model controls are unchanged except that successful changes advance the operation revision.
