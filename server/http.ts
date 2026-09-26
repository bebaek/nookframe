import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Workspace } from './workspace.js';
import type { ServerMessage } from '../shared/protocol.js';

export function createApp(workspace: Workspace, config: { token: string; origin: string; webDir: string }) {
  if (config.token.length < 32) throw new Error('Access token must be at least 32 characters');
  const expected = createHash('sha256').update(config.token).digest();
  const origin = new URL(config.origin).origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
    if (req.url !== '/ws' || req.headers.origin !== origin || wss.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  const authenticated = new Set<WebSocket>();
  function send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
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
  wss.on('connection', ws => {
    const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    let commandPending = false;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 30000);
    ws.on('error', () => { /* Socket close cleans up; never stop the agent. */ });
    ws.on('close', () => { clearTimeout(timeout); clearInterval(heartbeat); authenticated.delete(ws); });
    ws.on('message', async (raw, binary) => {
      let id: string | undefined;
      try {
        if (binary) throw new Error('Text JSON required');
        const command = JSON.parse(raw.toString());
        if (!command || typeof command !== 'object') throw new Error('Invalid command');
        if (!authenticated.has(ws)) {
          if (command.type !== 'auth' || typeof command.token !== 'string' || !timingSafeEqual(expected, createHash('sha256').update(command.token).digest())) {
            ws.close(1008, 'Invalid access token'); return;
          }
          authenticated.add(ws);
          clearTimeout(timeout);
          send(ws, { type: 'snapshot', state: workspace.state });
          return;
        }
        if (typeof command.id !== 'string' || command.id.length > 100) throw new Error('Request ID required');
        id = command.id;
        if (commandPending) throw new Error('A command is pending');
        if (!['prompt', 'stop', 'set_model'].includes(command.type)) throw new Error('Unsupported command');
        if (command.type === 'set_model' && (typeof command.provider !== 'string' || !command.provider || command.provider.length > 200 || typeof command.modelId !== 'string' || !command.modelId || command.modelId.length > 500)) throw new Error('Provider and model ID required');
        if (command.type === 'prompt' && (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 32000)) throw new Error('Prompt must be 1–32000 characters');
        commandPending = true;
        try {
          if (command.type === 'prompt') await workspace.prompt(command.text);
          else if (command.type === 'set_model') await workspace.setModel(command.provider, command.modelId);
          else await workspace.abort();
          send(ws, { type: 'snapshot', state: workspace.state });
          send(ws, { type: 'ack', id: command.id });
        } finally { commandPending = false; }
      } catch (error) {
        send(ws, { type: 'error', id, message: error instanceof Error ? error.message : 'Command failed' });
      }
    });
  });
  return {
    server,
    async close() {
      unsubscribe();
      if (timer) clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
