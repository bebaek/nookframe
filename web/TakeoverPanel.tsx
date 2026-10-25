import { useEffect, useRef, useState } from 'react';
import type { Takeover, ThreadChoice } from '../shared/protocol';

export function TakeoverPanel({ incoming, outgoing, lockedThreadId, connected, pending, selected, chat, threads, request, decide, open, inspect, notify, error, pendingAction, checkTarget, check }: {
  incoming: Takeover[]; outgoing?: Takeover; lockedThreadId?: string; connected: boolean; pending: boolean;
  error?: string; pendingAction?: string; checkTarget?: string; check: (id: string) => void;
  selected?: string; chat: boolean; threads: ThreadChoice[]; request: (id: string) => void;
  decide: (request: Takeover, decision: 'allow' | 'keep' | 'force' | 'cancel') => void;
  open: (request: Takeover) => void; inspect: (id: string) => void; notify: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const dialog = useRef<HTMLDialogElement>(null);
  const notified = useRef(new Set<string>());
  const waiting = incoming.find(r => r.status === 'pending' && r.deadline > now);
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (waiting && connected && focused && chat && waiting.threadId === selected) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else dialog.current?.close();
  }, [waiting?.id, connected, focused, chat, selected]);
  useEffect(() => {
    for (const r of incoming) {
      if (r.status !== 'pending' || r.deadline <= Date.now() || notified.current.has(r.id)) continue;
      notified.current.add(r.id);
      if (document.visibilityState !== 'visible' || !document.hasFocus()) notify(r.threadId);
    }
  }, [incoming]);
  const title = (id: string) => threads.find(thread => thread.id === id)?.title || id;
  const disabled = !connected || pending;
  const seconds = (r: Takeover) => Math.max(0, Math.ceil((r.deadline - now) / 1000));
  const buttons = waiting && <>
    <button disabled={disabled} onClick={() => decide(waiting, 'allow')}>Allow takeover</button>
    <button disabled={disabled} onClick={() => decide(waiting, 'keep')}>Keep here</button>
  </>;
  const progress = pendingAction === 'takeover_request' ? 'Requesting takeover…' : pendingAction === 'takeover_decide' ? 'Sending takeover response…' : pendingAction === 'takeover_open' ? 'Opening thread here…' : pendingAction === 'switch_thread' && checkTarget ? 'Checking thread ownership…' : undefined;
  return <section className="takeover-panel" aria-label="Thread takeover">
    {progress && <p role="status">{progress}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {checkTarget && (error || outgoing && ['failed', 'completed', 'cancelled'].includes(outgoing.status)) && <button disabled={disabled} onClick={() => check(checkTarget)}>Check thread</button>}
    {lockedThreadId && (!outgoing || ['rejected', 'cancelled', 'failed', 'completed'].includes(outgoing.status)) && <button disabled={disabled} onClick={() => {
      if (window.confirm(`Request takeover of “${title(lockedThreadId)}” on this slot? The other slot has 30 seconds to respond. Allowing takeover interrupts any active response; saved messages are kept.`)) request(lockedThreadId);
    }}>Take over on this slot</button>}
    {waiting && <>
      <div role="status">Slot {waiting.requesterSlot} wants to take over “{title(waiting.threadId)}”. {seconds(waiting)}s to respond. <button onClick={() => inspect(waiting.threadId)}>View request</button>{buttons}</div>
      <dialog ref={dialog} onCancel={e => e.preventDefault()} aria-labelledby="takeover-title">
        <h2 id="takeover-title">Allow thread takeover?</h2>
        <p>Slot {waiting.requesterSlot} is requesting “{title(waiting.threadId)}”. Allowing it interrupts the current response. Saved messages are kept.</p>
        <p>{seconds(waiting)} seconds remaining. Silence does not approve takeover.</p>
        {progress && <p role="status">{progress}</p>}
        {error && <p role="alert" className="error">{error}</p>}{buttons}
      </dialog>
    </>}
    {outgoing && <div role="status">
      {outgoing.status === 'pending' && seconds(outgoing) > 0 ? <>Waiting for slot {outgoing.ownerSlot} to release “{title(outgoing.threadId)}”: {seconds(outgoing)}s. <button disabled={disabled} onClick={() => decide(outgoing, 'cancel')}>Cancel</button></> :
        outgoing.status === 'expired' || outgoing.status === 'pending' ? <>No response from slot {outgoing.ownerSlot}. <button disabled={disabled || now > outgoing.deadline + 60_000} onClick={() => {
          if (window.confirm(`Take over “${title(outgoing.threadId)}” anyway? This will interrupt the other slot’s active response. Saved messages are kept.`)) decide(outgoing, 'force');
        }}>Take over anyway</button><button disabled={disabled} onClick={() => decide(outgoing, 'cancel')}>Cancel</button></> :
        outgoing.status === 'approved' || outgoing.status === 'stopping' ? <>Stopping the agent on slot {outgoing.ownerSlot}. Waiting for confirmed shutdown…</> :
        outgoing.status === 'released' ? <>Handoff confirmed. <button disabled={disabled} onClick={() => open(outgoing)}>Open thread here</button></> :
        <>{outgoing.status === 'rejected' ? 'The other user chose to keep the thread there.' : outgoing.status === 'failed' ? 'Takeover failed. Ownership or shutdown could not be confirmed; try opening the thread to inspect its status.' : outgoing.status === 'completed' ? 'This request is no longer active. Reopen the thread to inspect its current owner.' : 'Takeover cancelled.'}</>}
    </div>}
  </section>;
}
