import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage } from '../shared/protocol';

export function TerminalPane({ credential, visible }: { credential: string; visible: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
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
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 500,
      theme: { background: '#101419', foreground: '#e2e8ef' } });
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
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: credential }));
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
      socket.current?.close(); observer.disconnect(); input.dispose(); resize.dispose(); term.dispose();
    };
  }, [credential]);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => { fit.current?.fit(); terminal.current?.focus(); });
  }, [visible]);

  return <section className="terminal-pane" hidden={!visible}>
    <p className="terminal-note">Private terminal · not sent to chat or recorded by this app. Same workspace and permissions as the agent. Run <code>pi</code> for its TUI; avoid the chat session. Container restarts and maintenance shutdowns end this shell.</p>
    <div ref={container} className="terminal-screen" aria-label="Workspace terminal" />
    <div className="terminal-controls"><small role="status">{status}</small>
      {exited && <button type="button" disabled={!online} onClick={() => socket.current?.send(JSON.stringify({ type: 'terminal_start' }))}>New shell</button>}
      {([['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['Ctrl+D', '\x04'], ['Ctrl+L', '\x0c']] as const).map(([label, data]) => <button type="button" className="secondary" key={label} disabled={!online || exited} onClick={() => send(data)}>{label}</button>)}
      {([['↑', 'up', 'A'], ['↓', 'down', 'B'], ['←', 'left', 'D'], ['→', 'right', 'C']] as const).map(([label, direction, suffix]) => <button type="button" className="secondary" key={direction} aria-label={`Arrow ${direction}`} disabled={!online || exited} onClick={() => send(`${terminal.current?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['}${suffix}`)}>{label}</button>)}
      <button type="button" className="secondary" disabled={!online || exited} onClick={async () => {
        try { terminal.current?.paste(await navigator.clipboard.readText()); } catch { setStatus('Clipboard unavailable; use your browser’s paste action'); }
      }}>Paste</button>
      <button type="button" className="secondary" onClick={() => terminal.current?.clear()}>Clear screen</button>
    </div>
  </section>;
}
