import { useState } from 'react';
import type { ThreadChoice } from '../shared/protocol';

const PAGE_SIZE = 20;

export function ThreadSelect({ threads, selected, unread, disabled, select }: {
  threads: ThreadChoice[]; selected: string; unread: Set<string>; disabled: boolean; select: (id: string) => void;
}) {
  const [position, setPosition] = useState<{ selected: string; page: number }>();
  const pages = Math.max(1, Math.ceil(threads.length / PAGE_SIZE));
  const selectedIndex = threads.findIndex(thread => thread.id === selected);
  const page = Math.min(pages - 1, position?.selected === selected ? position.page : Math.max(0, Math.floor(selectedIndex / PAGE_SIZE)));
  const visible = threads.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const current = threads[selectedIndex];
  function option(thread: ThreadChoice) {
    return <option key={thread.id} value={thread.id}>{thread.busy ? 'Working · ' : ''}{unread.has(thread.id) ? 'New · ' : ''}{thread.title} · {new Date(thread.updatedAt).toLocaleString()}</option>;
  }
  return <>
    <label htmlFor="thread">Thread</label>
    <select id="thread" value={selected} disabled={disabled} onChange={event => select(event.target.value)}>
      {!selected && <option value="" disabled>New chat</option>}
      {!!selected && !current && <option value={selected}>New thread (unsaved)</option>}
      {current && !visible.some(thread => thread.id === selected) && option(current)}
      {visible.map(option)}
    </select>
    {pages > 1 && <nav className="thread-pagination" aria-label="Thread pages">
      <button type="button" disabled={disabled || page === 0} onClick={() => setPosition({ selected, page: page - 1 })}>Previous threads</button>
      <small role="status">Page {page + 1} of {pages} · {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, threads.length)} of {threads.length} threads</small>
      <button type="button" disabled={disabled || page === pages - 1} onClick={() => setPosition({ selected, page: page + 1 })}>Next threads</button>
    </nav>}
  </>;
}
