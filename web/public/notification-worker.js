// Notifications only: no fetch interception or caching.
const validThreadId = value => typeof value === 'string' && value.length > 0 && value.length < 2048;
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
    // Firefox Android can foreground the app without selecting a focused client.
    // Open the exact same-origin route directly in the click lifetime instead.
    // Do not navigate an unrelated tab: it may contain an unsent draft.
    event.waitUntil(self.clients.openWindow(target));
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
