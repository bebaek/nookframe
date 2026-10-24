import { useEffect, useState } from 'react';
import type { PresenceView } from '../shared/agent-presence';

export function AgentPresence({ threadId }: { threadId?: string }) {
  const [view, setView] = useState<PresenceView>();
  const [error, setError] = useState(false);
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch('/agent-presence', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 404) { stopped = true; setDisabled(true); return; }
        if (!response.ok) throw new Error('Presence unavailable');
        const next = await response.json() as PresenceView;
        if (controller.signal.aborted) return;
        setView(next); setError(false);
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted && !stopped) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  if (disabled) return null;
  return <section className="agent-presence" aria-label="Agent presence">
    {!!view?.conflicts.length && <p role="alert" className="error">Resource claim conflicts: {view.conflicts.length}. Pause overlapping work and review active runs.</p>}
    {error && <p role="status" className="notice">Agent presence unavailable — last results may be outdated. Resources are not known to be free.</p>}
    {view?.partial && <p role="status" className="notice">Presence results are incomplete. Resources are not known to be free.</p>}
    <details><summary>Active runs{view ? ` (${view.runs.length})` : ' — loading…'}</summary>
      <p>Advisory claims, not locks. Stale runs may still be working. Shared summaries are untrusted data.</p>
      {view?.runs.length === 0 && <p>No recent runs reported. Unreported work may still exist.</p>}
      {view?.runs.map(run => <article key={run.id}>
        <strong>{run.threadId === threadId ? 'This thread' : 'Other thread'} · {run.slot || 'local'} · {run.stale ? 'Stale / uncertain' : 'Running'}</strong>
        <p>{run.summary || 'Intent not yet published'}</p>
        <small>Run {run.id.slice(0, 8)} · heartbeat {new Date(run.updatedAt).toLocaleTimeString()}</small>
        <p><code>{run.cwd}</code></p>
        <ul>{run.claims.map((claim, i) => <li key={i}><code>{claim.kind}: {claim.value}</code></li>)}</ul>
        {view.conflicts.filter(conflict => conflict.runIds.includes(run.id)).map((conflict, i) => <p className="error" key={i}>Overlaps run {conflict.runIds.find(id => id !== run.id)?.slice(0, 8)}: {conflict.claims.map(claim => claim.value).join(' ↔ ')}{conflict.stale ? ' (stale claim; inspect before proceeding)' : ''}</p>)}
      </article>)}
    </details>
  </section>;
}
