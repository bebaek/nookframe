import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Workspace } from './workspace.js';
import { Workspaces, type WorkspaceLease } from './workspaces.js';
import type { TerminalSession } from './terminal.js';
import type { ServerMessage } from '../shared/protocol.js';
import { BrowserSessions, SESSION_SECONDS } from './browser-sessions.js';
import type { MailOAuth } from '../mail/oauth.js';
import type { ZohoMail } from '../mail/zoho.js';
import { MailError } from '../mail/store.js';
import type { CalendarOAuth } from '../calendar/oauth.js';
import { CalendarError } from '../calendar/store.js';

import { allowedBrowserOrigins } from './origins.js';
import { PhotoStore, validPhotoId, MAX_PHOTO_BYTES, type PhotoContent } from './photos.js';
import { ArtifactStore } from './artifacts.js';

import { defaultPromptExamples } from './prompt-examples.js';
import type { PresenceStore } from './agent-presence.js';
import type { OperationsReader } from './operations.js';
import type { ModelOperations } from './model-operations.js';

export function createApp(workspace: Workspace | Workspaces, config: { modelOperations?: ModelOperations; operations?: OperationsReader; presence?: PresenceStore; promptExamples?: string[]; token: string; origin: string; allowedOrigins?: string[]; webDir: string; terminal?: TerminalSession; stateDir?: string; mail?: MailOAuth; zoho?: ZohoMail; calendar?: CalendarOAuth }) {
  if (config.token.length < 32) throw new Error('Access token must be at least 32 characters');
  const pool = workspace instanceof Workspaces ? workspace : undefined;
  const single = pool ? undefined : workspace as Workspace;
  const selected = new Map<WebSocket, WorkspaceLease>();
  const snapshot = (ws: WebSocket) => ({
    ...(pool ? pool.snapshot(selected.get(ws)?.workspace) : single!.state),
    promptExamples: config.promptExamples ?? defaultPromptExamples,
  });
  const allowedOrigins = allowedBrowserOrigins(config.origin, config.allowedOrigins);
  const acceptsOrigin = (value: string | undefined) => value !== undefined && allowedOrigins.has(value);
  const origin = new URL(config.origin).origin;
  const secure = new URL(origin).protocol === 'https:';
  // Legacy cookie name intentionally survives the Nookframe branding migration.
  const cookieName = secure ? '__Host-pi-workspace-session' : 'pi-workspace-session';
  const cookie = (value: string, seconds: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  const sessions = new BrowserSessions(config.token, config.stateDir);
  const browserSockets = new Map<WebSocket, string>();
  const photos = config.stateDir ? new PhotoStore(join(config.stateDir, 'photos')) : undefined;
  const artifacts = config.stateDir ? new ArtifactStore(config.stateDir) : undefined;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.calendar && req.method === 'GET' && (req.url === '/calendar/oauth/callback' || req.url?.startsWith('/calendar/oauth/callback?'))) {
      // Cross-site OAuth return: single-use state + PKCE, not the Strict cookie.
      // Never log this URL or provider errors.
      let status = 'connected';
      try {
        if (req.url.length > 8192) throw new CalendarError('INVALID_OR_EXPIRED_AUTHORIZATION');
        await config.calendar.callback(new URL(req.url, origin));
      } catch (error) { status = error instanceof CalendarError ? error.code : 'AUTHORIZATION_FAILED'; }
      res.writeHead(303, { Location: `/calendar/oauth/result?status=${encodeURIComponent(status)}` }).end(); return;
    }
    if (config.calendar && req.method === 'GET' && req.url?.startsWith('/calendar/oauth/result?')) {
      const status = new URL(req.url, origin).searchParams.get('status');
      const known = new Set(['INVALID_OR_EXPIRED_AUTHORIZATION', 'AUTHORIZATION_DENIED', 'OAUTH_CLIENT_CHANGED_RETRY', 'OAUTH_CALLBACK_CHANGED_RECONFIGURE', 'OAUTH_CLIENT_NOT_CONFIGURED', 'OAUTH_REQUEST_FAILED', 'INVALID_TOKEN_RESPONSE', 'CALENDAR_READ_SCOPES_REQUIRED', 'VERIFIED_IDENTITY_REQUIRED', 'WRONG_ACCOUNT_FOR_ALIAS', 'ACCOUNT_ALREADY_CONNECTED', 'REFRESH_TOKEN_REQUIRED_REAUTHORIZE', 'CALENDAR_BUSY', 'RECONNECT_ACCOUNT']);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(status === 'connected' ? 'Calendar authorization stored. Run calendarctl account status to check. No calendar data has been fetched or changed.' : `Calendar authorization not completed (${known.has(status ?? '') ? status : 'AUTHORIZATION_FAILED'}). Request a fresh authorization link. Do not paste callback URLs or codes into chat.`); return;
    }
    if (config.zoho && req.method === 'GET' && (req.url === '/mail/zoho/oauth/callback' || req.url?.startsWith('/mail/zoho/oauth/callback?'))) {
      // Cross-site OAuth callback: single-use state and confidential server client.
      // Do not log callback URLs, codes, provider errors, or tokens.
      let connected = false;
      try {
        if (req.url.length > 8192) throw new MailError('INVALID_OR_EXPIRED_AUTHORIZATION');
        await config.zoho.callback(new URL(req.url, origin)); connected = true;
      } catch { /* Only a fixed, non-sensitive outcome reaches the browser. */ }
      res.writeHead(303, { Location: `/mail/zoho/oauth/result?status=${connected ? 'connected' : 'failed'}` }).end(); return;
    }
    if (config.zoho && req.method === 'GET' && req.url?.startsWith('/mail/zoho/oauth/result?')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(new URL(req.url, origin).searchParams.get('status') === 'connected'
        ? 'Zoho connected. Return to chat to check mailctl zoho status. No messages have been fetched, sent, or changed.'
        : 'Zoho authorization failed. Check the .com region, primary mailbox address, client configuration and scopes, then request a fresh link. Never paste callback URLs or codes into chat.'); return;
    }
    if (config.mail && req.method === 'GET' && (req.url === '/mail/oauth/callback' || req.url?.startsWith('/mail/oauth/callback?'))) {
      // OAuth returns via a cross-site navigation, so SameSite=Strict login cookies
      // are intentionally not required here. Single-use state + PKCE authenticate
      // the exchange. Never log this request URL: it contains an authorization code.
      let status = 'connected';
      try {
        if (req.url.length > 8192) throw new MailError('INVALID_OR_EXPIRED_AUTHORIZATION');
        await config.mail.callback(new URL(req.url, origin));
      } catch (error) { status = error instanceof MailError ? error.code : 'AUTHORIZATION_FAILED'; }
      res.writeHead(303, { Location: `/mail/oauth/result?status=${encodeURIComponent(status)}` }).end(); return;
    }
    if (config.mail && req.method === 'GET' && req.url?.startsWith('/mail/oauth/result?')) {
      const status = new URL(req.url, origin).searchParams.get('status');
      const known = new Set(['connected', 'INVALID_OR_EXPIRED_AUTHORIZATION', 'AUTHORIZATION_DENIED', 'OAUTH_CLIENT_CHANGED_RETRY', 'OAUTH_CALLBACK_CHANGED_RECONFIGURE', 'OAUTH_CLIENT_NOT_CONFIGURED', 'OAUTH_REQUEST_FAILED', 'INVALID_TOKEN_RESPONSE', 'GMAIL_IMAP_SCOPE_REQUIRED', 'VERIFIED_EMAIL_REQUIRED', 'WRONG_ACCOUNT_FOR_ALIAS', 'ACCOUNT_ALREADY_CONNECTED', 'REFRESH_TOKEN_REQUIRED_REAUTHORIZE', 'MAIL_BUSY', 'RECONNECT_ACCOUNT']);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(status === 'connected' ? 'Account connected. Return to chat and ask pi to check mail account status. No sync or mailbox changes have been started.' : `Authorization not completed (${known.has(status ?? '') ? status : 'AUTHORIZATION_FAILED'}). Return to chat to check setup and request a fresh authorization link. Do not paste callback URLs or codes into chat.`); return;
    }
    if (req.url === '/auth/session' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authenticated: !!sessions.identify(req.headers.cookie, cookieName) })); return;
    }
    if ((req.url === '/auth/login' || req.url === '/auth/logout') && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      // Explicit origin check protects cookie-backed login/logout from CSRF.
      if (!acceptsOrigin(req.headers.origin)) { res.writeHead(403).end(JSON.stringify({ error: 'Origin rejected' })); return; }
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
    if (req.url === '/api/operations' || req.url?.startsWith('/api/operations/')) {
      res.setHeader('Content-Type', 'application/json');
      // Reuse the existing access token and browser sessions. Browser requests
      // must have an allowed origin, including when they carry a bearer token.
      if (req.headers.origin !== undefined && !acceptsOrigin(req.headers.origin)) {
        res.writeHead(403).end(JSON.stringify({ error: 'Origin rejected' })); return;
      }
      const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!sessions.identify(req.headers.cookie, cookieName) && !sessions.verifyToken(bearer)) {
        res.writeHead(401).end(JSON.stringify({ error: 'Authentication required' })); return;
      }
      const operation = req.url.slice('/api/operations/'.length);
      if (operation.startsWith('models')) {
        if (!config.modelOperations) { res.writeHead(404).end(); return; }
        const url = new URL(req.url!, origin);
        const plan = /^\/api\/operations\/models\/plans\/([0-9a-f-]{36})(\/(?:apply|cancel))?$/.exec(url.pathname);
        try {
          if (req.method === 'GET' && url.pathname === '/api/operations/models') {
            res.end(JSON.stringify(config.modelOperations.catalog(url.searchParams.get('threadId') ?? ''))); return;
          }
          if (req.method === 'GET' && plan && !plan[2]) {
            res.end(JSON.stringify(config.modelOperations.get(plan[1]))); return;
          }
          if (req.method === 'POST' && (url.pathname === '/api/operations/models/plans' || plan?.[2])) {
            // Cookie writes require an explicit allowed Origin. Native bearer
            // clients can omit it; foreign origins were rejected above.
            if (!sessions.verifyToken(bearer) && !acceptsOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
            if (req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415).end(); return; }
            let body = '';
            for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) throw new Error('Request too large'); }
            const input: unknown = JSON.parse(body);
            // Recheck cookie expiry/revocation after receiving the request body.
            if (!sessions.verifyToken(bearer) && !sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
            if (plan) {
              if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Apply requires an empty JSON object');
              res.end(JSON.stringify(plan[2] === '/cancel' ? config.modelOperations.cancel(plan[1]) : await config.modelOperations.apply(plan[1])));
            } else res.end(JSON.stringify(config.modelOperations.propose(input, sessions.verifyToken(bearer) ? 'token' : 'browser')));
            return;
          }
          res.writeHead(405).end();
        } catch { res.writeHead(409).end(JSON.stringify({ error: 'Model operation rejected; inspect the target and proposal before retrying' })); }
        return;
      }
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.writeHead(405).end(); return; }
      if (!config.operations || !['status', 'config', 'sessions'].includes(operation)) { res.writeHead(404).end(); return; }
      try { res.end(JSON.stringify(config.operations[operation as keyof OperationsReader]())); }
      catch { res.writeHead(503).end(JSON.stringify({ error: 'Operation inspection unavailable' })); }
      return;
    }
    if (req.url === '/agent-presence') {
      if (!sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      if (!config.presence) { res.writeHead(404).end(); return; }
      try { res.end(JSON.stringify(config.presence.list())); }
      catch { res.writeHead(503).end(JSON.stringify({ error: 'Agent presence unavailable; do not assume resources are free' })); }
      return;
    }
    if (req.url?.startsWith('/artifacts/')) {
      if (!sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const match = /^\/artifacts\/([a-f0-9]{64})\/([a-f0-9]{64})\/(preview|full|download)$/.exec(req.url);
      if (!artifacts || !match) { res.writeHead(404).end(); return; }
      try {
        const image = await artifacts.read(match[1], match[2], match[3]);
        if (!sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
        res.setHeader('Content-Type', image.mimeType);
        if (match[3] === 'download') res.setHeader('Content-Disposition', `attachment; filename="${image.filename}"`);
        res.end(image.data);
      } catch { res.writeHead(404).end(); }
      return;
    }
    if (req.url?.startsWith('/response-images/')) {
      if (!sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      const id = req.url.slice('/response-images/'.length);
      if (!validPhotoId(id)) { res.writeHead(404).end(); return; }
      try {
        const data = await workspace.responseImages.read(id);
        // Sign-out during image processing must not release image bytes.
        if (!sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
        res.setHeader('Content-Type', 'image/png');
        res.end(data);
      } catch { res.writeHead(404).end(); }
      return;
    }
    if (req.url === '/photos' || req.url?.startsWith('/photos/')) {
      if (!sessions.identify(req.headers.cookie, cookieName)) { res.writeHead(401).end(); return; }
      if (!photos) { res.writeHead(503).end(); return; }
      try {
        if (req.method === 'POST' && req.url === '/photos') {
          if (!acceptsOrigin(req.headers.origin)) { res.writeHead(403).end(); return; }
          if (Number(req.headers['content-length'] ?? 0) > MAX_PHOTO_BYTES) { res.writeHead(413).end(); return; }
          workspace.assertThread(req.headers['x-thread-id']);
          const photo = await photos.upload(req);
          workspace.assertThread(req.headers['x-thread-id']);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(photo));
        } else if (req.method === 'GET') {
          const id = req.url.slice('/photos/'.length);
          if (!validPhotoId(id)) { res.writeHead(404).end(); return; }
          const data = workspace.photo(id) ?? await photos.read(id);
          res.setHeader('Content-Type', 'image/jpeg');
          res.end(data);
        } else res.writeHead(405).end();
      } catch (error) {
        res.writeHead(req.method === 'GET' ? 404 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: req.method === 'GET' ? 'Photo unavailable' : error instanceof Error ? error.message : 'Photo upload failed' }));
      }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/healthz') { const available = pool ? true : single!.state.available; res.writeHead(available ? 200 : 503).end(available ? 'ok' : 'unavailable'); return; }
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
    if ((req.url !== '/ws' && !(req.url === '/terminal' && config.terminal)) || !acceptsOrigin(req.headers.origin) || wss.clients.size >= 16) {
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
  // Coalesce streams; only subscribers receive conversation snapshots.
  // Other clients receive the shared catalog/running indicators.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Set<Workspace>();
  const unsubscribe = workspace.subscribe((changed?: Workspace) => {
    if (pool) {
      const ids = new Set(pool.snapshot().threads.map(thread => thread.id));
      for (const [ws, lease] of selected) {
        if (!ids.has(lease.workspace.state.threadId)) {
          lease.release(); selected.delete(ws);
          send(ws, { type: 'snapshot', state: snapshot(ws), selected: true });
        }
      }
    }
    if (changed) dirty.add(changed);
    timer ??= setTimeout(() => {
      timer = undefined;
      for (const ws of authenticated) {
        if (!pool || dirty.has(selected.get(ws)?.workspace!)) send(ws, { type: 'snapshot', state: snapshot(ws) });
        else send(ws, { type: 'threads', threads: pool.snapshot().threads });
      }
      dirty.clear();
    }, 50);
  });
  wss.on('connection', (ws, request) => {
    const isTerminal = request.url === '/terminal';
    let authorized = false;
    let authenticating = false;
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
    ws.on('close', () => { clearTimeout(timeout); clearInterval(heartbeat); authenticated.delete(ws); browserSockets.delete(ws); selected.get(ws)?.release(); selected.delete(ws); detachTerminal?.(); });
    ws.on('message', async (raw, binary) => {
      let id: string | undefined;
      try {
        if (binary) throw new Error('Text JSON required');
        const command = JSON.parse(raw.toString());
        if (!command || typeof command !== 'object') throw new Error('Invalid command');
        if (authenticating) throw new Error('Authentication is pending');
        if (!authorized) {
          const session = sessions.identify(request.headers.cookie, cookieName);
          // Raw token frames remain available to trusted CLI clients. Browsers
          // send only {type: 'auth'} and use the opaque HttpOnly cookie.
          if (command.type !== 'auth' || (!session && !sessions.verifyToken(command.token))) {
            ws.close(1008, 'Sign-in required; session expired or cookies unavailable'); return;
          }
          if (session) browserSockets.set(ws, session);
          authenticating = true;
          clearTimeout(timeout);
          if (isTerminal) detachTerminal = config.terminal!.attach(event => send(ws, event));
          else {
            if (pool) {
              try {
                if (command.threadId !== undefined && (typeof command.threadId !== 'string' || command.threadId.length > 255)) throw new Error('Invalid thread');
                if (command.threadId !== '') {
                  const lease = await pool.connect(command.threadId);
                  if (ws.readyState !== WebSocket.OPEN) { lease.release(); return; }
                  selected.set(ws, lease);
                }
              } catch (error) {
                send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Thread unavailable' });
              }
            }
            if (ws.readyState !== WebSocket.OPEN) return;
            authenticated.add(ws);
            send(ws, { type: 'snapshot', state: snapshot(ws), selected: true });
          }
          authorized = true; authenticating = false;
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
        if (!['prompt', 'stop', 'set_model', 'new_thread', 'switch_thread', 'delete_thread', 'release_thread'].includes(command.type)) throw new Error('Unsupported command');
        const current = selected.get(ws)?.workspace ?? single;
        if (pool && command.threadId !== (current?.state.threadId ?? '')) throw new Error('The selected thread changed. Review it before retrying.');
        current?.assertThread(command.threadId);
        if (command.type === 'switch_thread' && (typeof command.targetId !== 'string' || !command.targetId || command.targetId.length > 255)) throw new Error('Thread ID required');
        if (command.type === 'delete_thread' && (!pool || !current || command.targetId !== current.state.threadId)) throw new Error('Select the thread to delete first');
        if (command.type === 'set_model' && (typeof command.provider !== 'string' || !command.provider || command.provider.length > 200 || typeof command.modelId !== 'string' || !command.modelId || command.modelId.length > 500)) throw new Error('Provider and model ID required');
        if (command.type === 'prompt') {
          if (command.photos !== undefined && (!Array.isArray(command.photos) || command.photos.length > 4 || !command.photos.every(validPhotoId))) throw new Error('Attach at most four valid photos');
          if (typeof command.text !== 'string' || (!command.text.trim() && !command.photos?.length) || command.text.length > 32000) throw new Error('Enter a message (up to 32000 characters) or attach a photo');
        }
        commandPending = true;
        try {
          if (command.type === 'prompt') {
            const images: PhotoContent[] = [];
            for (const id of command.photos ?? []) {
              if (!photos) throw new Error('Photo uploads unavailable');
              let data: Buffer;
              try { data = await photos.read(id); } catch { throw new Error('Photo expired or unavailable; attach it again'); }
              images.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' });
            }
            if (!current) throw new Error('Select a thread first');
            current.assertThread(command.threadId);
            await current.prompt(command.text, images, command.clientContext);
          }
          else if (command.type === 'release_thread') {
            const lease = selected.get(ws);
            if (!pool || !lease) throw new Error('Select the thread to release first');
            await lease.releaseThread();
            selected.delete(ws);
          }
          else if (command.type === 'delete_thread') await pool!.deleteThread(command.targetId);
          else if (command.type === 'new_thread' || command.type === 'switch_thread') {
            if (pool) {
              const lease = await pool.connect(command.targetId, command.type === 'new_thread');
              if (ws.readyState !== WebSocket.OPEN) { lease.release(); return; }
              selected.get(ws)?.release(); selected.set(ws, lease);
            } else await single!.switchThread(command.type === 'new_thread' ? undefined : command.targetId);
          }
          else if (!current) throw new Error('Select a thread first');
          else if (command.type === 'set_model') await current.setModel(command.provider, command.modelId);
          else await current.abort();
          send(ws, { type: 'snapshot', state: snapshot(ws), selected: true });
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
      photos?.close();
      config.terminal?.close();
      if (timer) clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
