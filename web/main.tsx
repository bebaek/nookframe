import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, ServerMessage, ModelChoice, ThreadChoice } from '../shared/protocol';
import './style.css';
import { ToolCard } from './ToolCard';
import { MessageContent, ResponseImages } from './MessageContent';
import { PhotoPicker, PhotoPreviews, type DraftPhoto } from './Photos';
const TerminalPane = lazy(() => import('./TerminalPane').then(module => ({ default: module.TerminalPane })));

function App() {
  const [token, setToken] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authPending, setAuthPending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<Snapshot>();
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const catalog = useRef<ThreadChoice[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[state?.threadId ?? ''] ?? '';
  const [photoDrafts, setPhotoDrafts] = useState<Record<string, DraftPhoto[]>>({});
  const photos = photoDrafts[state?.threadId ?? ''] ?? [];
  const [uploading, setUploading] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  const [terminalOpened, setTerminalOpened] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const activeThread = useRef(new URLSearchParams(location.hash.slice(1)).get('thread') ?? undefined);
  const sent = useRef<{ id: string; text?: string; threadId: string; photos?: string[] } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);

  function lock() {
    setSignedIn(false); setConnected(false); setState(undefined); setDrafts({});
    setTerminalOpened(false); setTab('chat'); setToken('');
    sent.current = null; setPending(false);
    upload.current?.abort(); setPhotoDrafts({});
    catalog.current = []; setUnread(new Set());
  }

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function check() {
      try {
        const response = await fetch('/auth/session', { signal: controller.signal });
        if (!response.ok) throw new Error();
        const session = await response.json();
        if (!disposed) { setSignedIn(session.authenticated === true); setCheckingAuth(false); setError(''); }
      } catch {
        if (!disposed) { setError('Waiting for the workspace to reconnect…'); retry = setTimeout(check, 2000); }
      }
    }
    void check();
    return () => { disposed = true; controller.abort(); clearTimeout(retry); };
  }, []);

  async function authenticate(action: 'login' | 'logout') {
    setAuthPending(true); setError('');
    try {
      const response = await fetch(`/auth/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'login' ? { token } : {}) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Invalid access token' : 'Sign-in service unavailable; try again');
      setToken('');
      if (action === 'login') setSignedIn(true);
      else lock();
    } catch (error) { setError(error instanceof Error ? error.message : 'Authentication failed'); }
    finally { setAuthPending(false); }
  }

  useEffect(() => {
    if (!signedIn) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    function trackThreads(threads: ThreadChoice[], selected: string | undefined) {
      const previous = new Map(catalog.current.map(thread => [thread.id, thread]));
      catalog.current = threads;
      setUnread(current => {
        const next = new Set(current);
        for (const thread of threads) {
          const old = previous.get(thread.id);
          if (thread.id === selected) next.delete(thread.id);
          else if (old && (old.updatedAt !== thread.updatedAt || (old.busy && !thread.busy))) next.add(thread.id);
        }
        return next;
      });
    }
    function connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => { if (!disposed) ws.send(JSON.stringify({ type: 'auth', threadId: activeThread.current })); };
      ws.onmessage = event => {
        if (disposed) return;
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'snapshot') {
          if (activeThread.current !== undefined && message.state.threadId !== activeThread.current && !message.selected) return;
          activeThread.current = message.state.threadId || undefined;
          history.replaceState(null, '', `${location.pathname}${location.search}${message.state.threadId ? `#thread=${encodeURIComponent(message.state.threadId)}` : ''}`);
          trackThreads(message.state.threads, activeThread.current);
          setConnected(true); delay = 1000; setState(message.state);
        } else if (message.type === 'threads') {
          trackThreads(message.threads, activeThread.current);
          setState(current => current ? { ...current, threads: message.threads } : current);
        } else if (message.type === 'ack' && message.id === sent.current?.id) {
          const { text: acknowledgedText, threadId, photos: acknowledgedPhotos } = sent.current;
          if (acknowledgedPhotos) setPhotoDrafts(current => ({ ...current, [threadId]: (current[threadId] ?? []).filter(p => !acknowledgedPhotos.includes(p.key)) }));
          if (acknowledgedText !== undefined) setDrafts(current => current[threadId] === acknowledgedText ? { ...current, [threadId]: '' } : current);
          sent.current = null; setPending(false);
        } else if (message.type === 'error') {
          setError(message.message);
          if (message.id === sent.current?.id) { sent.current = null; setPending(false); }
        }
      };
      ws.onclose = event => {
        if (disposed) return;
        setConnected(false);
        if (sent.current) {
          setError('Connection lost before acknowledgement. Check history and the active model before retrying; any draft was kept.');
          sent.current = null; setPending(false);
        }
        if (event.code === 1008) { setError(event.reason || 'Authentication failed'); lock(); return; }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); socket.current?.close(); };
  }, [signedIn]);

  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [state]);

  useEffect(() => {
    if (tab !== 'chat' || !composer.current) return;
    composer.current.style.height = '0px';
    composer.current.style.height = `${Math.min(144, Math.max(44, composer.current.scrollHeight + 2))}px`;
    if (follow.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [draft, tab, signedIn]);

  async function uploadPhotos(items: DraftPhoto[], retry = false) {
    if (upload.current || pending || !state || state.threadChanging) return;
    const threadId = state.threadId;
    if (!retry && photos.length + items.length > 4) { setError('Attach at most four photos per message'); return; }
    if (items.some(p => p.file.size > 20 * 1024 * 1024)) { setError('Photos must be at most 20 MB each'); return; }
    if (!retry) setPhotoDrafts(current => ({ ...current, [threadId]: [...(current[threadId] ?? []), ...items] }));
    const controller = new AbortController(); upload.current = controller;
    setUploading(true); setError('');
    const update = (key: string, changes: Partial<DraftPhoto>) => setPhotoDrafts(current => ({ ...current, [threadId]: (current[threadId] ?? []).map(p => p.key === key ? { ...p, ...changes } : p) }));
    try {
      for (const item of items) {
        if (controller.signal.aborted) break;
        update(item.key, { error: undefined });
        try {
          const response = await fetch('/photos', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Thread-Id': threadId }, body: item.file, signal: controller.signal });
          if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.error || `Photo upload failed (${response.status})`);
          }
          const result = await response.json();
          update(item.key, { id: result.id, url: result.url, resized: result.resized === true });
        } catch (error) {
          if (!controller.signal.aborted) update(item.key, { error: error instanceof Error ? error.message : 'Photo upload failed' });
        }
      }
    } finally { upload.current = null; setUploading(false); }
  }
  function addPhotos(files: File[]) { void uploadPhotos(files.map(file => ({ key: crypto.randomUUID(), file }))); }
  const canSend = connected && state?.available && !state.busy &&
    !state.modelChanging && !state.threadChanging && !pending && !uploading && photos.every(p => p.id) && (!!draft.trim() || photos.length > 0);

  function command(type: 'prompt' | 'stop' | 'set_model' | 'new_thread' | 'switch_thread', model?: ModelChoice, targetId?: string) {
    if (!connected || pending || sent.current || !socket.current || (uploading && type !== 'stop')) return;
    const id = crypto.randomUUID();
    const threadId = state?.threadId ?? '';
    sent.current = { id, threadId, text: type === 'prompt' ? draft : undefined, photos: type === 'prompt' ? photos.map(p => p.key) : undefined };
    setPending(true); setError('');
    socket.current.send(JSON.stringify({ type, id, threadId, targetId, ...(type === 'prompt' ? { text: draft, photos: photos.map(p => p.id) } : {}), ...(model ? { provider: model.provider, modelId: model.id } : {}) }));
  }

  return <div className="app">
    <header><h1><span>Nookframe</span></h1>
      {signedIn && <nav className="tabs" role="tablist" aria-label="Workspace views">
        <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" role="tab" aria-selected={tab === 'terminal'} onClick={() => { setTerminalOpened(true); setTab('terminal'); }}>Terminal</button>
      </nav>}
      <span role="status" className={connected ? 'badge online' : 'badge'}>{connected ? state?.busy ? 'Working' : 'Ready' : signedIn ? 'Connecting…' : 'Locked'}</span>
      {signedIn && <button type="button" className="secondary controls-toggle" aria-label="Workspace controls" popoverTarget="workspace-controls">⋯</button>}
    </header>
    {checkingAuth ? <main className="login"><p>Checking sign-in…</p>{error && <p role="status">{error}</p>}</main> : !signedIn ? <main className="login"><h2>Open your workspace</h2><p>This grants access to a shell and all files inside your container.</p><form onSubmit={event => { event.preventDefault(); void authenticate('login'); }}><label htmlFor="token">Access token</label><input id="token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required /><button disabled={authPending}>Connect</button></form><small>Stay signed in on this browser for 30 days, including after redeployments. Use only trusted devices; cookies are required. The access token is not saved in browser storage.</small>{error && <p role="alert">{error}</p>}</main> : <>
      <section id="workspace-controls" popover="auto" aria-label="Workspace controls" className="workspace-controls">
      <div className="controls-heading"><h2>Workspace controls</h2><button type="button" className="secondary" aria-label="Close controls" popoverTarget="workspace-controls" popoverTargetAction="hide">×</button></div>
      {state && <section className="thread-picker">
        <label htmlFor="thread">Thread</label>
        <select id="thread" value={state.threadId} disabled={!connected || pending || uploading} onChange={e => command('switch_thread', undefined, e.target.value)}>
          {!state.threadId && <option value="" disabled>Choose a thread</option>}
          {state.threads.map(thread => <option key={thread.id} value={thread.id}>{thread.busy ? 'Working · ' : ''}{unread.has(thread.id) ? 'New · ' : ''}{thread.title} · {new Date(thread.updatedAt).toLocaleString()}</option>)}
        </select>
        <button type="button" disabled={!connected || pending || uploading} onClick={() => command('new_thread')}>New thread</button>
        <small>{state.threadChanging ? 'Switching…' : 'Selected in this tab only · other threads keep running · same files'}</small>
      </section>}
      {state && <section className="model-picker"><label htmlFor="model">Model</label><select id="model" value={state.model} disabled={!connected || !state.available || state.busy || state.modelChanging || state.threadChanging || pending || uploading || state.modelSource === 'environment'} onChange={e => {
        const choice = state.models.find(m => `${m.provider}/${m.id}` === e.target.value);
        if (choice) command('set_model', choice);
      }}>
        {!state.models.some(m => `${m.provider}/${m.id}` === state.model) && <option value={state.model}>{state.model}</option>}
        {state.models.map(m => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.provider}/{m.id}</option>)}
      </select><small>{state.modelChanging ? 'Switching…' : state.modelSource === 'environment' ? 'Locked by environment override' : state.modelSource === 'saved' ? 'Saved for this thread and restarts' : 'Pi default · select a model to save your preference'}</small></section>}
      <p className="controls-note">One workspace · last 200 messages in this thread</p>
      <button type="button" className="secondary sign-out" disabled={authPending} onClick={() => void authenticate('logout')}>Sign out</button>
      </section>
      <section className="chat-pane" hidden={tab !== 'chat'}>
      <div className="conversation-context" title={state?.model}><span className="conversation-title">{state?.threads.find(thread => thread.id === state.threadId)?.title || 'Chat'}</span><span>{state?.model.split('/').at(-1)}</span></div>
      <main className="transcript" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
        {!state?.messages.length && <div className="empty"><h2>What shall we work on?</h2>
          {!!state?.promptExamples?.length && <div className="prompt-examples" aria-label="Prompt examples">{state.promptExamples.map((example, index) =>
            <button key={index} type="button" className="secondary" disabled={!connected || !state.available || state.busy || state.threadChanging || pending || uploading || !!draft.trim() || photos.length > 0} onClick={() => {
              setDrafts(current => ({ ...current, [state.threadId]: example }));
              composer.current?.focus();
            }}>{example}</button>
          )}</div>}
        </div>}
        {state?.messages.map(message => message.tool ? <ToolCard key={`${state.threadId}:${message.tool.id}`} tool={message.tool} /> : <article key={message.id} className={`message ${message.role}`}><label>{message.role === 'toolResult' ? 'Tool result' : message.role}</label>{message.role === 'toolResult' ? <details><summary>Output</summary><pre>{message.text}</pre></details> : message.role === 'assistant' ? <MessageContent text={message.text} /> : <div className="text">{message.text}</div>}<PhotoPreviews photos={message.photos} /><ResponseImages images={message.images} />{message.details && <details><summary>Tool calls</summary><pre>{message.details}</pre></details>}{message.error && <p className="error">{message.error}</p>}</article>)}
        {state?.liveText && <article className="message assistant"><label>pi · writing</label><MessageContent text={state.liveText} /></article>}
        <div ref={bottom} />
      </main>
      <footer onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); addPhotos(Array.from(e.dataTransfer.files)); }}>{!connected && <p role="status" className="notice">Disconnected — reconnecting; tasks continue</p>}{state?.notice && <p role="status" className="notice">{state.notice}</p>}{error && <p role="alert" className="error">{error}</p>}<PhotoPicker key={state?.threadId ?? ''} photos={photos} disabled={tab !== 'chat' || !connected || !state || state.threadChanging || pending} uploading={uploading} add={addPhotos} remove={key => setPhotoDrafts(current => ({ ...current, [state?.threadId ?? '']: photos.filter(p => p.key !== key) }))} retry={() => void uploadPhotos(photos.filter(p => !p.id), true)} /><form onSubmit={e => { e.preventDefault(); if (canSend) command('prompt'); }}><textarea onPaste={e => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); addPhotos(files); } }} ref={composer} onKeyDown={e => {
        // Keep mobile Enter and IME confirmation native (229 covers Safari IME).
        if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
          e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey ||
          e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        if (!e.repeat && canSend) e.currentTarget.form?.requestSubmit();
      }} aria-label="Message" placeholder="Message pi…" value={draft} maxLength={32000} onChange={e => setDrafts(current => ({ ...current, [state?.threadId ?? '']: e.target.value }))} disabled={!state || state.threadChanging} rows={1} /><div className="actions">{state?.busy && <button type="button" className="secondary" disabled={!connected || pending} onClick={() => command('stop')}>Stop</button>}<button disabled={!canSend}>Send</button></div></form></footer>
      </section>
      {terminalOpened && <Suspense fallback={<p hidden={tab !== 'terminal'}>Opening terminal…</p>}><TerminalPane visible={tab === 'terminal'} /></Suspense>}
    </>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
