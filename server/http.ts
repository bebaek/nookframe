import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Workspace } from './workspace.js';
import type { TerminalSession } from './terminal.js';
import type { ServerMessage } from '../shared/protocol.js';
import { BrowserSessions, SESSION_SECONDS } from './browser-sessions.js';

export function createApp(workspace: Workspace, config: { token: string; origin: string; webDir: string; terminal?: TerminalSession; stateDir?: string }) {
  if (config.token.length < 32) throw new Error('Access token must be at least 32 characters');
  const origin = new URL(config.origin).origin;
  const secure = new URL(origin).protocol === 'https:';
  const cookieName = secure ? '__Host-pi-workspace-session' : 'pi-workspace-session';
  const cookie = (value: string, seconds: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const sessions = new BrowserSessions(config.token, config.stateDir);
  const browserSockets = new Map<WebSocket, string>();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (req.url === '/auth/session' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authenticated: !!sessions.identify(req.headers.cookie, cookieName) })); return;
    }
    if ((req.url === '/auth/login' || req.url === '/auth/logout') && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      // Explicit origin check protects cookie-backed login/logout from CSRF.
      if (req.headers.origin !== origin) { res.writeHead(403).end(JSON.stringify({ error: 'Origin rejected' })); return; }
      try {
        if (req.url === '/auth/login') {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415).end(); return; }
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 4096) throw new Error('Request too large');
          }
          let token: unknown;
          try { token = JSON.parse(body).token; } catch { res.writeHead(400).end(JSON.stringify({ error: 'Invalid request' })); return; }
          if (!sessions.verifyToken(token)) { res.writeHead(401).end(JSON.stringify({ error: 'Invalid access token' })); return; }
          res.setHeader('Set-Cookie', cookie(sessions.issue(), SESSION_SECONDS));
        } else {
          const id = sessions.identify(req.headers.cookie, cookieName);
          if (id) {
            sessions.revoke(id);
            for (const [ws, session] of browserSockets) if (session === id) ws.close(1008, 'Signed out');
          }
          res.setHeader('Set-Cookie', cookie('', 0));
        }
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(503).end(JSON.stringify({ error: 'Authentication service unavailable' })); }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/healthz') { res.writeHead(workspace.state.available ? 200 : 503).end(workspace.state.available ? 'ok' : 'unavailable'); return; }
    const path = req.url === '/' ? '/index.html' : req.url ?? '';
    // Serve only build artifacts, never the workspace, config, or arbitrary paths.
    if (path !== '/index.html' && !/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path)) { res.writeHead(404).end(); return; }
    try {
      const data = await readFile(resolve(config.webDir, '.' + path));
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      res.setHeader('Content-Type', `${mime[extname(path)]}; charset=utf-8`);
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url !== '/ws' && !(req.url === '/terminal' && config.terminal)) || req.headers.origin !== origin || wss.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  const authenticated = new Set<WebSocket>();
  function send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const session = browserSockets.get(ws);
    if (session && !sessions.valid(session)) { ws.close(1008, 'Sign-in expired'); return; }
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Reconnect to refresh'); return; }
    ws.send(JSON.stringify(message));
  }
  // Coalesce streaming updates; every browser receives a replaceable snapshot.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = workspace.subscribe(() => {
    timer ??= setTimeout(() => {
      timer = undefined;
      for (const ws of authenticated) send(ws, { type: 'snapshot', state: workspace.state });
    }, 50);
  });
  wss.on('connection', (ws, request) => {
    const isTerminal = request.url === '/terminal';
    let authorized = false;
    let detachTerminal: (() => void) | undefined;
    const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    let commandPending = false;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      const session = browserSockets.get(ws);
      if (session && !sessions.valid(session)) ws.close(1008, 'Sign-in expired');
      else if (!alive) ws.terminate();
      else { alive = false; ws.ping(); }
    }, 30000);
    ws.on('error', () => { /* Socket close cleans up; never stop the agent. */ });
    ws.on('close', () => { clearTimeout(timeout); clearInterval(heartbeat); authenticated.delete(ws); browserSockets.delete(ws); detachTerminal?.(); });
    ws.on('message', async (raw, binary) => {
      let id: string | undefined;
      try {
        if (binary) throw new Error('Text JSON required');
        const command = JSON.parse(raw.toString());
        if (!command || typeof command !== 'object') throw new Error('Invalid command');
        if (!authorized) {
          const session = sessions.identify(request.headers.cookie, cookieName);
          // Raw token frames remain available to trusted CLI clients. Browsers
          // send only {type: 'auth'} and use the opaque HttpOnly cookie.
          if (command.type !== 'auth' || (!session && !sessions.verifyToken(command.token))) {
            ws.close(1008, 'Sign-in required; session expired or cookies unavailable'); return;
          }
          if (session) browserSockets.set(ws, session);
          authorized = true;
          clearTimeout(timeout);
          if (isTerminal) detachTerminal = config.terminal!.attach(event => send(ws, event));
          else {
            authenticated.add(ws);
            send(ws, { type: 'snapshot', state: workspace.state });
          }
          return;
        }
        const session = browserSockets.get(ws);
        if (session && !sessions.valid(session)) { ws.close(1008, 'Sign-in expired'); return; }
        if (isTerminal) {
          if (command.type === 'terminal_input' && typeof command.data === 'string' && command.data.length <= 16000) config.terminal!.input(command.data);
          else if (command.type === 'terminal_resize') config.terminal!.resize(command.cols, command.rows);
          else if (command.type === 'terminal_start') config.terminal!.start();
          else throw new Error('Invalid terminal command');
          return;
        }
        if (typeof command.id !== 'string' || command.id.length > 100) throw new Error('Request ID required');
        id = command.id;
        if (commandPending) throw new Error('A command is pending');
        if (!['prompt', 'stop', 'set_model', 'new_thread', 'switch_thread'].includes(command.type)) throw new Error('Unsupported command');
        workspace.assertThread(command.threadId);
        if (command.type === 'switch_thread' && (typeof command.targetId !== 'string' || !command.targetId || command.targetId.length > 255)) throw new Error('Thread ID required');
        if (command.type === 'set_model' && (typeof command.provider !== 'string' || !command.provider || command.provider.length > 200 || typeof command.modelId !== 'string' || !command.modelId || command.modelId.length > 500)) throw new Error('Provider and model ID required');
        if (command.type === 'prompt' && (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 32000)) throw new Error('Prompt must be 1–32000 characters');
        commandPending = true;
        try {
          if (command.type === 'prompt') await workspace.prompt(command.text);
          else if (command.type === 'set_model') await workspace.setModel(command.provider, command.modelId);
          else if (command.type === 'new_thread') await workspace.switchThread();
          else if (command.type === 'switch_thread') await workspace.switchThread(command.targetId);
          else await workspace.abort();
          send(ws, { type: 'snapshot', state: workspace.state });
          send(ws, { type: 'ack', id: command.id });
        } finally { commandPending = false; }
      } catch (error) {
        send(ws, { type: 'error', id, message: isTerminal ? 'Terminal request failed' : error instanceof Error ? error.message : 'Command failed' });
      }
    });
  });
  return {
    server,
    async close() {
      unsubscribe();
      config.terminal?.close();
      if (timer) clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
