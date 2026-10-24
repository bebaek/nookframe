# Thread ownership and multitasking

Each browser connection selects its own thread. The URL fragment (`#thread=…`)
retains that selection across reloads and reconnects; browser login cookies do
not select a conversation. Two tabs selecting the same thread deliberately share
one agent. Different threads can run concurrently, and switching away does not
stop a task. Stop and model changes apply only to the selected thread.

## Lifecycle and ownership

`Workspaces` lazily starts one Pi RPC process per opened thread. Opens and
reclamation are serialized, while agent execution is independent per thread.
There are at most four resident agents per server. When full, the oldest
unsubscribed idle agent is stopped before another opens. Unsubscribed idle agents
are also reclaimed after about five minutes. Busy agents and agents still viewed
by a browser are never reclaimed. If all slots are occupied, close an idle tab or
wait for background work to finish. Reopening a reclaimed thread reloads its JSONL.

To transfer an idle thread to another slot immediately, choose **Release thread**
under Workspace controls on the owning slot. This stops its agent, confirms exit,
and releases ownership without the idle timeout. Saved messages, preferences,
and job history are kept. Release is refused while work is active, ownership is
uncertain, or another tab/lease is viewing the thread on that slot. Close other
viewers first. Stop alone and ordinary navigation still retain the cached agent.

Successful release leaves this tab at the thread chooser; refresh and reconnect
keep it there until you explicitly select a thread. A lost acknowledgement is
not retried and also leaves reconnect at the chooser, avoiding accidental
reacquisition. Release does not force ownership away from another slot.

Before starting/loading an agent, the server acquires a `proper-lockfile` lock on
the validated session JSONL path (30-second stale timeout, 10-second heartbeat).
Ownership lasts until the agent has stopped. A second server cannot load a
writable copy of an owned thread: the UI reports the conflict and offers other
threads/New thread instead. Losing ownership makes the controller unavailable
and stops its agent. Failed shutdowns retain ownership rather than permit a
second writer. After a crash, stale ownership can be reclaimed after the timeout.
Do not manually remove a live lock. As with any heartbeat lock, this assumes a
reliable filesystem and reasonably responsive event loops; it is not distributed
fencing against arbitrary process suspension or storage failure.

**Upgrade warning:** older Nookframe releases and terminal Pi processes do not
honor these session locks. Do not open the same conversation there while using
the new server. Stop older agents before transferring their conversations. The
shared terminal itself remains one shell; this change separates chat, not PTYs.

## Background job threads

Opt-in manual jobs share the pool's capacity and session ownership locks. A running
job thread can be viewed and stopped, but cannot accept prompts, model changes,
or deletion. Stop requests durable cancellation; the thread stays read-only while
process exit is pending. After confirmed exit and final run persistence, the pool
replaces the restricted agent with an interactive agent under the same lock.
Existing browser leases follow that replacement, preserving the selected thread.
An uncertain shutdown retains ownership and blocks continuation. See
[background jobs](scheduled-jobs.md) for capabilities and remaining work.

## Persistence and limits

Pi JSONL remains authoritative. Per-thread model preferences and interrupted-run
markers live in `workspace-sessions/.nookframe/<sha256-of-filename>/`. Include the
entire sessions directory in private backups. The existing global model setting
is a fallback for threads without their own preference. Environment model
overrides still lock selection. `active-thread.json` is read only as a legacy
landing-thread preference; new selections do not update it.

The legacy global `run-active` marker is not migrated to individual threads;
inspect any unfinished work when upgrading. Per-thread markers cover subsequent
runs. `/healthz` reports server readiness, not every agent's health: one unavailable
agent must not take unrelated conversations offline. Its error is shown in chat.

Thread catalogs and running indicators are shared across connected clients;
conversation snapshots go only to subscribers of that thread. Catalog discovery
is refreshed on local opens/reclamation; threads created by another server may
require a local open or restart to appear. Drafts remain per-thread, in tab memory
only. Uncertain commands are never automatically retried.

This is **not multi-user isolation**. All signed-in clients retain access to all
threads and media. Agents share files, credentials, tools, and external accounts.
Use separate Git worktrees for concurrent coding tasks; avoid simultaneous writes
to the same checkout or other shared resources. Locks prevent two participating
servers writing one conversation, not conflicting edits in different threads.

## Agent presence and advisory claims

Managed chat agents load a trusted `agent_presence` extension. Before shared
writes, the agent is instructed to inspect concurrent runs and publish a short,
non-sensitive intent with its planned resources. For example:

```json
{
  "summary": "Implementing the settings panel in an isolated worktree",
  "claims": [
    { "kind": "path", "value": "/workspace/code/nookframe-settings" },
    { "kind": "resource", "value": "deploy:fallback" }
  ]
}
```

Calling `agent_presence` with `{}` lists runs and conflicts. Publishing requires
both `summary` and `claims`, and replaces the entire claim set; `claims: []`
releases claims. Paths are canonicalized (including symlinked existing ancestors)
and overlap parent/child paths, not similarly named siblings. Resource names
match exactly and need an agreed convention, such as `deploy:main`. Separate
worktrees avoid checkout overlap but not shared Git operations, deployments,
external accounts, or other infrastructure; claim those resources separately.

**Active runs** above the transcript shows intents, paths, slot names, heartbeats,
and conflicts. Conflict warnings remain visible when the list is collapsed.
Browser clients poll the authenticated, read-only `/agent-presence` endpoint
about every five seconds. Agents inspect fresh results when they call the tool;
there is no peer messaging or automatic conflict resolution.

### Lifecycle, storage, and trust

- A random run ID is allocated on `agent_start`. Retries and queued continuations
  retain it until `agent_settled`, not `agent_end`. Settlement/shutdown removes
  that run's record and claims. Idle sessions do not advertise active work.
- Heartbeats run every ten seconds. After thirty seconds without an update,
  records are marked **stale / uncertain**, but their conflicts still warn.
  A stale record is not permission to take over: a suspended agent or background
  subprocess may still be writing. Processes spawned by an agent are not tracked.
- Records use atomic per-run files under
  `PI_CODING_AGENT_DIR/agent-presence/`, shared across participating slots using
  that agent directory. No per-slot state or live chat transcript is shared.
  Crashed records are shown for up to 24 hours. Older records are ignored, not
  automatically deleted; remove abandoned records only after verifying their
  processes have stopped. Readers cap records and output bytes, and mark
  malformed, omitted, or unreadable records as incomplete results.
- Only explicit summaries/claims and bounded run metadata are published: no
  automatic prompt snippets, tool arguments/results, message history, credentials,
  or internal reasoning. Summaries are agent-supplied **untrusted data**, not
  instructions; do not put secrets in them. They may also persist in the calling
  agent's tool transcript and backups.
- The trust boundary is Nookframe's existing **single owner/shared agent directory**.
  All authenticated browser clients and participating agents can see these
  records. This is not tenant isolation: never share an agent directory between
  unrelated owners. `NOOKFRAME_AGENT_PRESENCE=0` disables the integration on a
  server (including its agents). Independent installations need separate agent
  directories. Do not expose the presence directory through a static file server.

Claims are **advisory, not locks, leases, authorization, or fencing**. Publication
and conflict checks are not an atomic reservation; simultaneous claims can both
succeed and report overlap. Recheck before critical writes and pause or select
separate resources on conflict. Unavailable, partial, stale, or empty results
never establish that a resource is free. Older servers, already-running agents,
terminal sessions, and job workers not loading this extension are not reported.
Continue using session locks, separate worktrees, and deployment slot safeguards.
