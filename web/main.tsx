import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, ServerMessage, ModelChoice } from '../shared/protocol';
import './style.css';
const TerminalPane = lazy(() => import('./TerminalPane').then(module => ({ default: module.TerminalPane })));

function App() {
  const [token, setToken] = useState('');
  const [credential, setCredential] = useState('');
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<Snapshot>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  const [terminalOpened, setTerminalOpened] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const sent = useRef<{ id: string; text?: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    if (!credential) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    function connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: credential }));
      ws.onmessage = event => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'snapshot') {
          setConnected(true); delay = 1000; setState(message.state);
        } else if (message.type === 'ack' && message.id === sent.current?.id) {
          const acknowledgedText = sent.current.text;
          if (acknowledgedText !== undefined) setDraft(current => current === acknowledgedText ? '' : current);
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
        if (event.code === 1008) { setError(event.reason || 'Authentication failed'); setCredential(''); return; }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); socket.current?.close(); };
  }, [credential]);

  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [state]);

  function command(type: 'prompt' | 'stop' | 'set_model', model?: ModelChoice) {
    if (!connected || pending || !socket.current) return;
    const id = crypto.randomUUID();
    sent.current = { id, text: type === 'prompt' ? draft : undefined };
    setPending(true); setError('');
    socket.current.send(JSON.stringify({ type, id, ...(type === 'prompt' ? { text: draft } : {}), ...(model ? { provider: model.provider, modelId: model.id } : {}) }));
  }

  return <div className="app">
    <header><div><h1>Pi <span>Workspace</span></h1><small>{state?.model || 'Your personal computer, through chat'}</small></div><span className={connected ? 'badge online' : 'badge'}>{connected ? state?.busy ? 'Working' : 'Ready' : credential ? 'Connecting…' : 'Locked'}</span></header>
    {!credential ? <main className="login"><h2>Open your workspace</h2><p>This grants access to a shell and all files inside your container.</p><form onSubmit={event => { event.preventDefault(); setError(''); setCredential(token); setToken(''); }}><label htmlFor="token">Access token</label><input id="token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required /><button>Connect</button></form><small>The token stays in memory only. Refreshing requires signing in again.</small>{error && <p role="alert">{error}</p>}</main> : <>
      <nav className="tabs" role="tablist" aria-label="Workspace views">
        <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" role="tab" aria-selected={tab === 'terminal'} onClick={() => { setTerminalOpened(true); setTab('terminal'); }}>Terminal</button>
      </nav>
      <section className="chat-pane" hidden={tab !== 'chat'}>
      {state && <section className="model-picker"><label htmlFor="model">Model</label><select id="model" value={state.model} disabled={!connected || !state.available || state.busy || state.modelChanging || pending || state.modelSource === 'environment'} onChange={e => {
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
      <footer>{state?.notice && <p role="status" className="notice">{state.notice}</p>}{error && <p role="alert" className="error">{error}</p>}<form onSubmit={e => { e.preventDefault(); command('prompt'); }}><textarea aria-label="Message" placeholder="Ask pi to work in your workspace…" value={draft} maxLength={32000} onChange={e => setDraft(e.target.value)} rows={3} /><div className="actions"><small>{connected ? 'One persistent workspace · last 200 messages' : 'Disconnected — reconnecting; tasks continue'}</small><button type="button" className="secondary" disabled={!connected || !state?.busy || pending} onClick={() => command('stop')}>Stop</button><button disabled={!connected || !state?.available || state.busy || state.modelChanging || pending || !draft.trim()}>Send</button></div></form></footer>
      </section>
      {terminalOpened && <Suspense fallback={<p hidden={tab !== 'terminal'}>Opening terminal…</p>}><TerminalPane credential={credential} visible={tab === 'terminal'} /></Suspense>}
    </>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
