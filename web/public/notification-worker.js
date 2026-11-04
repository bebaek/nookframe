// Notifications only: no fetch interception or caching.
const validThreadId = value => typeof value === 'string' && value.length > 0 && value.length < 2048;
// WindowClient.url can lag behind SPA history changes. Ask the live page rather
// than trusting its cached URL. Bound discovery so suspended tabs cannot hang a tap.
function currentThread(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = value => {
      clearTimeout(timer);
      channel.port1.close(); channel.port2.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 800);
    channel.port1.onmessage = event => finish(event.data?.type === 'attention-view' ? event.data.threadId : undefined);
    try { client.postMessage({ type: 'query-attention-view' }, [channel.port2]); }
    catch { finish(undefined); }
  });
}
self.addEventListener('push', event => {
  // Only the opaque destination is included in the encrypted payload; never chat text.
  let payload;
  try { payload = event.data?.json(); } catch { /* Older/malformed pushes open home. */ }
  const threadId = payload?.type === 'attention' && validThreadId(payload.threadId) ? payload.threadId : undefined;
  event.waitUntil(self.registration.showNotification('Nookframe needs your attention', {
    body: 'An agent run has ended. Open Nookframe to review the result.',
    tag: threadId ? `nookframe:push:${threadId}` : 'nookframe:push',
    data: { push: true, ...(threadId ? { threadId } : {}) },
  }));
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const client = event.source;
  if (!client || client.type !== 'window' || new URL(client.url).origin !== self.location.origin) return;
  const data = event.data;
  if (data?.type === 'clear-attention') {
    event.waitUntil(self.registration.getNotifications().then(notifications => {
      for (const notification of notifications) {
        if (notification.data?.clientId === client.id) notification.close();
      }
    }));
  } else if (data?.type === 'show-attention' && typeof data.threadId === 'string' && data.threadId.length > 0 && data.threadId.length < 2048) {
    event.waitUntil(self.registration.showNotification('Nookframe needs your attention', {
      body: data.takeover === true ? 'Another slot requests this thread. Open Nookframe to allow takeover or keep it here.' : 'An agent run has ended. Open the conversation to review the result.',
      tag: `nookframe:${client.id}:${data.threadId}`,
      data: { clientId: client.id, threadId: data.threadId },
    }).catch(() => client.postMessage({ type: 'attention-error' })));
  }
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.notification.data?.push === true) {
    const threadId = event.notification.data.threadId;
    const target = validThreadId(threadId) ? `/#thread=${encodeURIComponent(threadId)}` : '/';
    // Firefox Android can resolve focus() successfully yet show its last active
    // tab. No capability probe distinguishes that behavior, so narrowly bypass
    // reuse for this browser/platform; desktop and other browsers keep discovery.
    const userAgent = self.navigator?.userAgent ?? '';
    if (/\bAndroid\b/i.test(userAgent) && /\bFirefox\//i.test(userAgent)) {
      event.waitUntil(self.clients.openWindow(target));
      return;
    }
    event.waitUntil((async () => {
      if (validThreadId(threadId)) {
        try {
          // Includes tabs in other windows and tabs not yet controlled by this worker.
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          const views = await Promise.all(clients.map(async client => {
            try {
              const url = new URL(client.url);
              if (url.origin !== self.location.origin || url.pathname !== '/') return undefined;
              return await currentThread(client) === threadId ? client : undefined;
            } catch { return undefined; }
          }));
          for (const client of views) {
            if (!client) continue;
            try {
              const focused = await client.focus();
              // A resolved WindowClient is the API's success signal. Requiring its
              // focused snapshot to already be true can create duplicate tabs.
              if (focused) {
                client.postMessage({ type: 'open-attention', threadId });
                return;
              }
            } catch { /* Closed tab or denied focus: try the next match. */ }
          }
        } catch { /* Client discovery failed: open the destination instead. */ }
      }
      // Never navigate an unrelated tab away from an unsent draft.
      // Firefox/OS controls activation; open a tab when reuse cannot be confirmed.
      await self.clients.openWindow(target);
    })());
    return;
  }
  const { clientId, threadId } = event.notification.data || {};
  if (typeof clientId !== 'string' || typeof threadId !== 'string' || !threadId || threadId.length >= 2048) return;
  event.waitUntil((async () => {
    const client = await self.clients.get(clientId);
    if (client?.type === 'window' && new URL(client.url).origin === self.location.origin) {
      // Invoke activation directly in the click lifetime, before conversation navigation.
      const activation = client.focus();
      client.postMessage({ type: 'open-attention', threadId });
      try { await activation; } catch { /* Navigation still works if the compositor denies focus. */ }
    } else {
      await self.clients.openWindow(`/#thread=${encodeURIComponent(threadId)}`);
    }
  })());
});
