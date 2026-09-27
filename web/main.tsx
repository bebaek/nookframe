import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, ServerMessage, ModelChoice } from '../shared/protocol';
import './style.css';
const TerminalPane = lazy(() => import('./TerminalPane').then(module => ({ default: module.TerminalPane })));

function App() {
  const [token, setToken] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authPending, setAuthPending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<Snapshot>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[state?.threadId ?? ''] ?? '';
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  const [terminalOpened, setTerminalOpened] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const sent = useRef<{ id: string; text?: string; threadId: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  function lock() {
    setSignedIn(false); setConnected(false); setState(undefined); setDrafts({});
    setTerminalOpened(false); setTab('chat'); setToken('');
    sent.current = null; setPending(false);
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
    function connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => { if (!disposed) ws.send(JSON.stringify({ type: 'auth' })); };
      ws.onmessage = event => {
        if (disposed) return;
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'snapshot') {
          setConnected(true); delay = 1000; setState(message.state);
        } else if (message.type === 'ack' && message.id === sent.current?.id) {
          const { text: acknowledgedText, threadId } = sent.current;
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

  function command(type: 'prompt' | 'stop' | 'set_model' | 'new_thread' | 'switch_thread', model?: ModelChoice, targetId?: string) {
    if (!connected || pending || !socket.current) return;
    const id = crypto.randomUUID();
    const threadId = state?.threadId ?? '';
    sent.current = { id, threadId, text: type === 'prompt' ? draft : undefined };
    setPending(true); setError('');
    socket.current.send(JSON.stringify({ type, id, threadId, targetId, ...(type === 'prompt' ? { text: draft } : {}), ...(model ? { provider: model.provider, modelId: model.id } : {}) }));
  }

  return <div className="app">
    <header><div><h1>Pi <span>Workspace</span></h1><small>{state?.model || 'Your personal computer, through chat'}</small></div><span className={connected ? 'badge online' : 'badge'}>{connected ? state?.busy ? 'Working' : 'Ready' : signedIn ? 'Connecting…' : 'Locked'}</span>{signedIn && <button type="button" className="secondary sign-out" disabled={authPending} onClick={() => void authenticate('logout')}>Sign out</button>}</header>
    {checkingAuth ? <main className="login"><p>Checking sign-in…</p>{error && <p role="status">{error}</p>}</main> : !signedIn ? <main className="login"><h2>Open your workspace</h2><p>This grants access to a shell and all files inside your container.</p><form onSubmit={event => { event.preventDefault(); void authenticate('login'); }}><label htmlFor="token">Access token</label><input id="token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required /><button disabled={authPending}>Connect</button></form><small>Stay signed in on this browser for 30 days, including after redeployments. Use only trusted devices; cookies are required. The access token is not saved in browser storage.</small>{error && <p role="alert">{error}</p>}</main> : <>
      <nav className="tabs" role="tablist" aria-label="Workspace views">
        <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" role="tab" aria-selected={tab === 'terminal'} onClick={() => { setTerminalOpened(true); setTab('terminal'); }}>Terminal</button>
      </nav>
      <section className="chat-pane" hidden={tab !== 'chat'}>
      {state?.threadId && <section className="thread-picker">
        <label htmlFor="thread">Thread</label>
        <select id="thread" value={state.threadId} disabled={!connected || !state.available || state.busy || state.modelChanging || state.threadChanging || pending} onChange={e => command('switch_thread', undefined, e.target.value)}>
          {state.threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title} · {new Date(thread.updatedAt).toLocaleString()}</option>)}
        </select>
        <button type="button" disabled={!connected || !state.available || state.busy || state.modelChanging || state.threadChanging || pending} onClick={() => command('new_thread')}>New thread</button>
        <small>{state.threadChanging ? 'Switching…' : 'Shared active thread across browsers · separate histories, same files'}</small>
      </section>}
      {state && <section className="model-picker"><label htmlFor="model">Model</label><select id="model" value={state.model} disabled={!connected || !state.available || state.busy || state.modelChanging || state.threadChanging || pending || state.modelSource === 'environment'} onChange={e => {
        const choice = state.models.find(m => `${m.provider}/${m.id}` === e.target.value);
        if (choice) command('set_model', choice);
      }}>
        {!state.models.some(m => `${m.provider}/${m.id}` === state.model) && <option value={state.model}>{state.model}</option>}
        {state.models.map(m => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.provider}/{m.id}</option>)}
      </select><small>{state.modelChanging ? 'Switching…' : state.modelSource === 'environment' ? 'Locked by environment override' : state.modelSource === 'saved' ? 'Saved for future sessions and restarts' : 'Pi default · select a model to save your preference'}</small></section>}
      <main className="transcript" onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
        {!state?.messages.length && <div className="empty"><h2>What shall we work on?</h2><p>Try: “Create a hello.txt file in the workspace.”</p></div>}
        {state?.messages.map(message => <article key={message.id} className={`message ${message.role}`}><label>{message.role === 'toolResult' ? 'Tool result' : message.role}</label>{message.role === 'toolResult' ? <details><summary>Output</summary><pre>{message.text}</pre></details> : <div className="text">{message.text}</div>}{message.details && <details><summary>Tool calls</summary><pre>{message.details}</pre></details>}{message.error && <p className="error">{message.error}</p>}</article>)}
        {state?.liveText && <article className="message assistant"><label>pi · writing</label><div className="text">{state.liveText}</div></article>}
        {Object.entries(state?.tools ?? {}).map(([id, tool]) => <article className="message" key={id}><details open><summary>{tool.name} · running</summary><pre>{tool.output}</pre></details></article>)}
        <div ref={bottom} />
      </main>
      <footer>{state?.notice && <p role="status" className="notice">{state.notice}</p>}{error && <p role="alert" className="error">{error}</p>}<form onSubmit={e => { e.preventDefault(); command('prompt'); }}><textarea aria-label="Message" placeholder="Ask pi to work in your workspace…" value={draft} maxLength={32000} onChange={e => setDrafts(current => ({ ...current, [state?.threadId ?? '']: e.target.value }))} disabled={!state || state.threadChanging} rows={3} /><div className="actions"><small>{connected ? 'One workspace · last 200 messages in this thread' : 'Disconnected — reconnecting; tasks continue'}</small><button type="button" className="secondary" disabled={!connected || !state?.busy || pending} onClick={() => command('stop')}>Stop</button><button disabled={!connected || !state?.available || state.busy || state.modelChanging || state.threadChanging || pending || !draft.trim()}>Send</button></div></form></footer>
      </section>
      {terminalOpened && <Suspense fallback={<p hidden={tab !== 'terminal'}>Opening terminal…</p>}><TerminalPane visible={tab === 'terminal'} /></Suspense>}
    </>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
