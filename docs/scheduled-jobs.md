# Scheduled agent jobs (in progress)

Nookframe jobs are chat-first, with a CLI fallback and no dedicated UI.
This first increment implements **paused definitions only**. There is no
scheduler, agent execution, chat-management skill, or result delivery yet.
Creating a definition does not schedule or run an agent. `run`, `resume`,
`pause`, `runs`, and `cancel` fail explicitly rather than pretending to work.

## CLI

In the installed image:

```sh
nookframe jobs list
nookframe jobs create --file job.json
nookframe jobs show JOB_ID
nookframe jobs preview JOB_ID
nookframe jobs update JOB_ID --revision 1 --file changes.json
nookframe jobs delete JOB_ID --revision 2
```

In a checkout, use `npm run jobs -- <command>`. All successful commands emit
JSON on stdout; failures emit a JSON error on stderr and exit nonzero.
Update and delete require the revision last read, preventing stale chat turns
or concurrent CLI sessions from silently overwriting another edit.

Example definition:

```json
{
  "name": "Morning homelab review",
  "prompt": "Inspect homelab health. Report unavailable services, failed backups and recurring errors. Do not modify anything.",
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

Definitions live under `NOOKFRAME_JOBS_DIR`, defaulting to `$STATE_DIR/jobs`
(or `.local/state/jobs` in a checkout). Both slots must use the same durable
directory. The catalog uses a shared filesystem lock, revision checks, private
file permissions, atomic rename, and file/directory fsync. Corrupt or unknown
schema versions are rejected, not reset. Back up this directory privately;
prompts may contain personal information. The lock assumes a reliable filesystem
and responsive processes; it is not distributed fencing.

## Remaining increments

1. Restricted runner and durable run ledger: fresh thread per run, enforced
   read-only tools, immutable prompt/revision snapshots, bounded concurrency,
   cancellation and timeout handling. Never automatically replay uncertain runs.
2. Scheduler: explicit owning `NOOKFRAME_SLOT`, shared dispatch guard, deterministic
   occurrence IDs, skip missed runs, and crash-boundary tests. No automatic failover.
3. Interactive chat skill/tools using the same service as the CLI. Confirm new
   jobs and changes in plain text. Background agents cannot manage schedules.
4. Results delivered through ordinary chat threads, with attention-only filtering
   and visible failures; no Jobs screen or custom confirmation cards.

Do not enable execution using ordinary interactive agents: those agents inherit
shell, credentials, skills, and write-capable extensions. A read-only prompt is
not an enforced security boundary.
