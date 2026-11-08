import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage } from '../shared/protocol';

export function TerminalPane({ visible }: { visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const search = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [hasSelection, setHasSelection] = useState(false);
  const [appearance, setAppearance] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('nookframe.terminal.appearance') || '{}');
      return { fontSize: [12, 14, 16, 18, 20].includes(saved?.fontSize) ? saved.fontSize as number : 14,
        contrast: saved?.contrast === true };
    } catch { return { fontSize: 14, contrast: false }; }
  });

  function find(previous = false) {
    if (!query) { search.current?.clearDecorations(); setSearchStatus(''); return; }
    const found = previous ? search.current?.findPrevious(query) : search.current?.findNext(query);
    setSearchStatus(found ? 'Match selected' : 'No matches');
  }
  function closeSearch() {
    setSearchOpen(false); search.current?.clearDecorations(); setSearchStatus(''); terminal.current?.focus();
  }
  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.fontSize = appearance.fontSize;
      terminal.current.options.theme = appearance.contrast
        ? { background: '#000000', foreground: '#ffffff' }
        : { background: '#101419', foreground: '#e2e8ef' };
      if (visible) fit.current?.fit();
    }
    try { localStorage.setItem('nookframe.terminal.appearance', JSON.stringify(appearance)); } catch { /* Storage may be blocked. */ }
  }, [appearance, visible]);
  useEffect(() => { if (searchOpen && visible) searchInput.current?.focus(); }, [searchOpen, visible]);
  const [status, setStatus] = useState('Connecting…');
  const [online, setOnline] = useState(false);
  const [exited, setExited] = useState(false);

  function send(data: string) {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) return;
    if (data.length > 16000) { setStatus('Paste is too large (maximum 16000 characters)'); return; }
    socket.current.send(JSON.stringify({ type: 'terminal_input', data }));
    terminal.current?.focus();
  }
  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: appearance.fontSize, scrollback: 10000,
      theme: appearance.contrast ? { background: '#000000', foreground: '#ffffff' } : { background: '#101419', foreground: '#e2e8ef' } });
    const searching = new SearchAddon();
    search.current = searching;
    term.loadAddon(searching);
    term.attachCustomKeyEventHandler(event => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyF') {
        if (event.type === 'keydown') { setSearchOpen(true); searchInput.current?.focus(); }
        return false;
      }
      return true;
    });
    const selection = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
    const sizing = new FitAddon();
    terminal.current = term; fit.current = sizing;
    term.loadAddon(sizing); term.open(container.current!);
    const input = term.onData(send);
    const resize = term.onResize(({ cols, rows }) => {
      if (ready.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'terminal_resize', cols, rows }));
    });
    const observer = new ResizeObserver(() => {
      if (container.current?.clientWidth && container.current?.clientHeight) sizing.fit();
    });
    observer.observe(container.current!);
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let attached = false;
    let queuedOutput = 0;
    function connect() {
      let connectionReady = false;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal`);
      socket.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
      ws.onmessage = event => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'terminal_ready') {
          ready.current = true; setOnline(true); setExited(false); setStatus('Connected'); delay = 1000;
          if (attached && !connectionReady) term.writeln('\r\n[Reconnected; output while disconnected is not replayed. Ctrl+L redraws the shell.]');
          attached = true; connectionReady = true;
          if (container.current?.clientWidth) sizing.fit();
          // Force SIGWINCH on reattach, even at the same size, so TUIs can redraw.
          ws.send(JSON.stringify({ type: 'terminal_resize', cols: Math.max(2, term.cols - 1), rows: term.rows }));
          setTimeout(() => {
            if (!disposed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'terminal_resize', cols: term.cols, rows: term.rows }));
          }, 100);
          term.focus();
        } else if (message.type === 'terminal_data') {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (queuedOutput + message.data.length > 2 * 1024 * 1024) { ws.close(1013, 'Output too fast'); return; }
          queuedOutput += message.data.length;
          term.write(message.data, () => { queuedOutput -= message.data.length; });
        } else if (message.type === 'terminal_exit') {
          ready.current = false; setExited(true); setStatus(`Shell exited (${message.code})`);
          term.writeln(`\r\n[Shell exited (${message.code})]`);
        } else if (message.type === 'error') setStatus(message.message);
      };
      ws.onclose = event => {
        ready.current = false;
        if (disposed) return;
        setOnline(false); setStatus('Disconnected — shell continues running');
        if (event.code === 1008) { setStatus('Authentication failed; reload to sign in again'); return; }
        retry = setTimeout(connect, delay); delay = Math.min(15000, delay * 2);
      };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => {
      disposed = true; clearTimeout(retry); ready.current = false;
      socket.current?.close(); observer.disconnect(); input.dispose(); resize.dispose(); selection.dispose(); term.dispose();
    };
  }, []);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
  }, [visible, maximized]);

  return <section className={`terminal-pane${maximized ? ' terminal-maximized' : ''}`} hidden={!visible}>
    <div className="terminal-toolbar" role="group" aria-label="Terminal tools">
      <button type="button" className="secondary" aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? 'Restore' : 'Maximize'}</button>
      <button type="button" className="secondary" aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>Search</button>
      <label>Font size <select aria-label="Terminal font size" value={appearance.fontSize} onChange={event => setAppearance(value => ({ ...value, fontSize: Number(event.target.value) }))}>
        {[12, 14, 16, 18, 20].map(size => <option key={size} value={size}>{size}px</option>)}
      </select></label>
      <label><input type="checkbox" checked={appearance.contrast} onChange={event => setAppearance(value => ({ ...value, contrast: event.target.checked }))} /> High contrast</label>
    </div>
    {searchOpen && <form className="terminal-search" onSubmit={event => { event.preventDefault(); find(); }}>
      <input ref={searchInput} aria-label="Search terminal" placeholder="Search scrollback" value={query} onChange={event => { setQuery(event.target.value); setSearchStatus(''); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); }
        if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); find(true); }
      }} />
      <button type="button" className="secondary" disabled={!query} onClick={() => find(true)}>Previous</button>
      <button type="submit" className="secondary" disabled={!query}>Next</button>
      <button type="button" className="secondary" onClick={closeSearch}>Close search</button>
      <small role="status">{searchStatus}</small>
    </form>}
    <details className="terminal-note"><summary>Private terminal · session help</summary><p>Not sent to chat or recorded by this app. Same workspace and permissions as the agent. Run <code>pi</code> for its TUI; avoid the chat session. Container restarts and maintenance shutdowns end this shell. Search with Ctrl/⌘+Shift+F; Enter finds next, Shift+Enter previous. Appearance is saved on this browser; terminal output is not.</p></details>
    <div ref={container} className="terminal-screen" aria-label="Workspace terminal" />
    <div className="terminal-controls"><small role="status">{status}</small>
      {exited && <button type="button" disabled={!online} onClick={() => socket.current?.send(JSON.stringify({ type: 'terminal_start' }))}>New shell</button>}
      {([['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['Ctrl+D', '\x04'], ['Ctrl+L', '\x0c']] as const).map(([label, data]) => <button type="button" className="secondary" key={label} disabled={!online || exited} onClick={() => send(data)}>{label}</button>)}
      {([['↑', 'up', 'A'], ['↓', 'down', 'B'], ['←', 'left', 'D'], ['→', 'right', 'C']] as const).map(([label, direction, suffix]) => <button type="button" className="secondary" key={direction} aria-label={`Arrow ${direction}`} disabled={!online || exited} onClick={() => send(`${terminal.current?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${suffix}`)}>{label}</button>)}
      <button type="button" className="secondary" disabled={!hasSelection} onClick={async () => {
        try { await navigator.clipboard.writeText(terminal.current?.getSelection() || ''); }
        catch { setStatus('Clipboard unavailable; use your browser’s copy action'); }
      }}>Copy selection</button>
      <button type="button" className="secondary" onClick={() => { terminal.current?.scrollToBottom(); terminal.current?.focus(); }}>Latest output</button>
      <button type="button" className="secondary" disabled={!online || exited} onClick={async () => {
        try { terminal.current?.paste(await navigator.clipboard.readText()); } catch { setStatus('Clipboard unavailable; use your browser’s paste action'); }
      }}>Paste</button>
      <button type="button" className="secondary" onClick={() => terminal.current?.clear()}>Clear screen</button>
    </div>
  </section>;
}
