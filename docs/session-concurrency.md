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
