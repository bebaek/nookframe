# Background agent jobs (in progress)

Jobs are chat-first with a CLI fallback, not a dedicated Jobs UI. Definitions,
manual background execution, durable run history, cancellation, and same-thread
continuation are implemented. Interactive agents load the jobs-management skill.
**Automatic scheduling, service-specific read profiles, and attention-only delivery
are not yet implemented.**
Definitions remain paused; schedule previews do not dispatch work. The `notify`
field is stored for future delivery, not currently acted on.

## Chat workflow

Ask naturally: “List my jobs”, “Save a weekday report-review job”, “Run that job
now”, “Stop that run”, or “What happened on its last run?” The interactive jobs
skill uses the same CLI/store as terminal users; no dedicated UI is added.

Before creating, editing, deleting, or running, the agent presents the exact
operation in plain text and asks for confirmation. An unambiguous Stop request
is handled immediately. Ambiguous names and missing timezones are clarified.
Confirmations are conversational skill instructions, not a new CLI authorization
mechanism. The existing trusted-user security model is unchanged.

The agent must explain that schedules remain paused and notification preferences
are not delivered yet. Manual run submissions are reported as queued until the
ledger says otherwise; a configured slot does not prove a runner is alive.
Run IDs survive retries, revision conflicts require renewed review, and an
uncertain outcome must never be bypassed by editing state or removing locks.
The skill is not loaded into restricted background agents.

## CLI

In the installed image:

```sh
nookframe jobs status
nookframe jobs list
nookframe jobs create --file job.json
nookframe jobs show JOB_ID
nookframe jobs preview JOB_ID
nookframe jobs update JOB_ID --revision 1 --file changes.json
nookframe jobs run JOB_ID --revision 2 --request-id UUID
nookframe jobs runs JOB_ID
nookframe jobs run-show RUN_ID
nookframe jobs cancel RUN_ID
nookframe jobs delete JOB_ID --revision 2
```

In a checkout, use `npm run jobs -- <command>`. Commands emit JSON on stdout;
failures emit a JSON error on stderr and exit nonzero. Update, delete and run
require the revision last read. Generate a UUID once for each intended manual
run (for example, `node -p 'crypto.randomUUID()'`). Repeating the same job/revision
and request ID returns the original run, even after completion, rather than
executing again. A new UUID means a new request. Run commands only enqueue work;
inspect `runs` to find its actual status and thread ID. `runs` without an ID lists
all history, including deleted jobs. `run-show` retrieves one exact run, including
its immutable job snapshot and recorded summary. `status` describes capabilities,
configured/current slots and the tool profile; `runnerLiveness` is explicitly
`unknown`, not a health probe. Create/update accept JSON on stdin with `--file -`
as well as a file path (64 KiB maximum). Invalid JSON errors do not echo input.

Example definition for the **current filesystem-read-only profile**:

```json
{
  "name": "Review exported health report",
  "prompt": "Read /workspace/reports/health.txt and summarize problems. Report missing or stale data; do not infer live service health or change anything.",
  "schedule": {
    "kind": "weekly",
    "time": "08:00",
    "timezone": "Europe/Berlin",
    "days": [0, 1, 2, 3, 4, 5, 6]
  },
  "notify": "attention",
  "timeoutSeconds": 300
}
```

Days are Sunday=0 through Saturday=6; all seven means daily. One-shot schedules
use `{"kind":"once","at":"2030-01-01T08:00:00+01:00"}`. Timezones are explicit.
Preview returns the next scheduled occurrence strictly after now, **not a promise
of execution**. Missing DST minutes are skipped; repeated minutes use only their
first occurrence. Past one-shot dates have no next occurrence.

## Enable manual execution

Execution is opt-in. Set `NOOKFRAME_JOBS_SLOT` to the designated instance's
`NOOKFRAME_SLOT` value on the server (and in the CLI environment). Only that slot
starts a runner. Both instances and the CLI must use the same durable
`NOOKFRAME_JOBS_DIR`, which defaults to `$STATE_DIR/jobs` or `.local/state/jobs`.
The runner also holds a shared filesystem ownership lock; a second owner fails
startup rather than competing. No automatic failover is implemented.

One background agent runs at a time, sharing the existing four-agent limit. It
never evicts a viewed or busy interactive agent. When capacity is full, requests
stay queued. Queued requests survive restarts and have not yet been dispatched.
The runner saves the immutable job snapshot and dispatch/thread metadata before
starting the agent. Each run uses a fresh thread and the current server model
selection; a follow-up conversation does not affect future runs.

The initial tool profile permits only `read`, `grep`, `find`, and `ls`. Shell,
write/edit, codemode, MCP, extensions, skills, templates, and context discovery
are disabled. It cannot query Home Assistant, mail, or calendars yet. This is
**tool-level restriction, not filesystem or network sandboxing**: read tools can
access any file readable by the process, including credentials. Only use trusted
prompts and appropriate inputs. Trusted provider configuration and provider
credentials are still used by Pi; do not treat it as isolation for untrusted jobs.

## View, Stop, continue

Select a running job's ordinary thread on the owning instance, or open
`/#thread=THREAD_ID`. Viewing attaches to the existing restricted agent. Send,
model changes and thread deletion are blocked server-side during the run.

The existing **Stop** button and `jobs cancel RUN_ID` request the same durable
cancellation. Queued runs cancel immediately. Running threads show **Stopping…**
and remain view-only until the process has actually exited. Cancellation affects
this run only; it never changes the job definition.

On completion, cancellation or timeout, Nookframe confirms process exit, saves
its final status and summary, then replaces the restricted agent with an
interactive agent on the same thread. Existing viewers follow the replacement;
they do not need to switch threads. The session lock is held continuously across
this handoff—background ownership is relinquished by process exit without an
unlocked interval in which another server could start a writer. Following up uses
normal interactive permissions. The original run status and summary stay immutable.
To move this completed thread to another slot, close other viewers and choose
**Release thread** in Workspace controls on the owning slot. This stops the idle
interactive agent and releases its lock immediately; it does not delete the
conversation or change the job/run. Running, stopping, and uncertain jobs cannot
be explicitly released.

If termination or persistence is uncertain, no interactive replacement starts.
The run stays blocked and is never automatically retried. On restart, dispatched
but unfinished records become `uncertain`, and the runner refuses new work while
any such record remains. Recovery currently requires operator inspection; there
is deliberately no force-resume command. Do not delete a live lock or blindly
edit a run back to queued. Confirm the old process has exited and inspect its
thread before any recovery. The background RPC wrapper exits if its server parent
dies; this is a crash guard, not distributed fencing against arbitrary suspension.

## Persistence and limits

The catalog and run ledger use a shared directory lock, private file permissions,
atomic rename, and file/directory fsync. Corrupt or unknown schema versions are
rejected, not reset. Back up the jobs directory and the session directory privately;
prompts, summaries and transcripts may contain personal information. Run history
is retained without automatic pruning in this increment.

Timeouts are wall-clock bounds on normal execution, not guarantees that an
unresponsive process can be safely reclaimed at that instant. Cancellation and
startup RPCs can add latency. If process exit cannot be confirmed, ownership stays
blocked. Locks assume a reliable filesystem and responsive processes; they are
not distributed fencing. Main/fallback still do not share live chat state.

## Remaining increments

- Reviewed, least-privilege service-specific read profiles.
- Schedule dispatch, deterministic occurrence IDs and missed-run policy.
- Attention-only result delivery through existing chat, with visible failures.
- Operator recovery workflow and run-history retention policy.
