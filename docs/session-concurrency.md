# Shared-profile concurrency: deferred work

Nookframe permits multiple server instances to use the same agent profile,
workspace, and state directories. The former server-lifetime lock on
`PI_CODING_AGENT_DIR` has been removed to allow an old deployment to remain live
while a replacement starts. Credential, Google, and mail-operation locks remain
unchanged; this is not a general removal of file locking.

## Accepted limitation

This does **not** make concurrent access to one conversation safe. Each server
starts its own Pi RPC process and keeps an independent in-memory session tree.
Both can restore the same session through shared `active-thread.json`. Pi's
session persistence appends JSONL entries without a cross-process session lock;
some operations rewrite the file. Separate processes do not automatically reload
one another's conversation state. Atomic file creation or individual appends do
not solve stale context, conflicting branches, or lost updates during rewrites.

Even sequential use after a deployment switch can use stale in-memory state if
both instances loaded the conversation earlier. Shared selected-thread/model
preferences can also overwrite one another. Avoid writing to the same thread
from both instances; prefer a fresh, distinct thread for testing. This remains
an operational convention, not an enforced guarantee. Keep backups and do not
assume switching back to the older server restores conversation data.

## Future work

- Define ownership at the session level rather than locking the entire profile.
- Acquire ownership before loading a writable session, including thread switches.
- Release ownership after draining/stopping the corresponding RPC process.
- Reload session state when ownership moves between servers.
- Decide whether selected-thread preferences should be per instance.
- Handle an already-owned session without preventing the server from starting
  (for example, show it read-only or let the user choose a different thread).
- Test simultaneous opens/writes, stale readers, takeover after crashes, thread
  switching, and promotion/rollback with both servers alive.

Do not delete a live older server's profile lock directory. New versions simply
no longer acquire that lock; an older process can release its own lock normally
on shutdown.
