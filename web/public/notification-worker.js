// Notification activation only: no fetch interception, caching, or push subscription.
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
      body: 'An agent run has ended. Open the conversation to review the result.',
      tag: `nookframe:${client.id}:${data.threadId}`,
      data: { clientId: client.id, threadId: data.threadId },
    }).catch(() => client.postMessage({ type: 'attention-error' })));
  }
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
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
