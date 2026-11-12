import { useEffect, useState } from 'react';
import type { ThreadChoice } from '../shared/protocol';

type Match = ThreadChoice & { excerpt?: string };

export function ThreadSearch({ threads, disabled, select }: {
  threads: ThreadChoice[]; disabled: boolean; select: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ query: string; threads: Match[]; truncated?: boolean }>();
  const [error, setError] = useState('');
  const term = query.trim();
  useEffect(() => {
    setResult(undefined);
    setError('');
    if (!term || disabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/threads/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
          if (!response.ok) throw new Error();
          const data = await response.json();
          if (!controller.signal.aborted) setResult({ query: term, ...data });
        } catch {
          if (!controller.signal.aborted) setError('Message search unavailable. Showing title matches only.');
        }
      })();
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [term, disabled]);
  const matches: Match[] = result?.query === term ? result.threads : threads.filter(thread => thread.title.toLowerCase().includes(term.toLowerCase()));
  return <div className="thread-search">
    <label htmlFor="thread-search">Search threads</label>
    <input id="thread-search" type="search" maxLength={256} placeholder="Titles and messages…" value={query}
      disabled={disabled} onChange={event => setQuery(event.target.value)} />
    {term && <>
      <small role="status">{error || (result?.query === term ? `${matches.length} matching threads${result.truncated ? ' (first 50)' : ''}` : 'Searching messages…')}{!matches.length && result?.query === term ? ' · No matches' : ''}</small>
      <ul aria-label="Thread search results">{matches.map(thread => <li key={thread.id}>
        <button type="button" disabled={disabled} onClick={() => { select(thread.id); setQuery(''); }}>
          <strong>{thread.title}</strong><time>{new Date(thread.updatedAt).toLocaleString()}</time>
          {thread.excerpt && <span>{thread.excerpt}</span>}
        </button>
      </li>)}</ul>
    </>}
  </div>;
}
