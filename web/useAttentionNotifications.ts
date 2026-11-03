import { useEffect, useRef, useState } from 'react';
import type { ThreadChoice } from '../shared/protocol';
import { AttentionTracker, chatNeedsAttention } from './attention';

const preference = 'nookframe.attentionNotifications';
const supported = () => typeof Notification !== 'undefined' && window.isSecureContext;

export function useAttentionNotifications(selected: string | undefined, chat: boolean, open: (id: string) => void, signedIn = true) {
  const [enabled, setEnabled] = useState(() => {
    try { return supported() && Notification.permission === 'granted' && localStorage.getItem(preference) === 'true'; }
    catch { return false; }
  });
  const [status, setStatus] = useState('');
  const tracker = useRef(new AttentionTracker());
  const notifications = useRef(new Set<Notification>());
  const worker = useRef<Promise<ServiceWorker | undefined> | undefined>(undefined);
  const generation = useRef(0);
  const pushEnabled = useRef(false);
  const pushSetup = useRef<Promise<void>>(Promise.resolve());
  const toggling = useRef(false);

  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error();
    const active = await prepareWorker();
    if (!active) throw new Error();
    const registration = await navigator.serviceWorker.ready;
    const response = await fetch('/api/push');
    if (!response.ok) throw new Error();
    const { publicKey } = await response.json();
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const saved = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) });
    if (!saved.ok) throw new Error();
    pushEnabled.current = true;
    setStatus('Background push notifications enabled for this browser.');
  }

  function prepareWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(undefined);
    return worker.current ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          navigator.serviceWorker.register('/notification-worker.js', { scope: '/', updateViaCache: 'none' })
            .then(() => navigator.serviceWorker.ready).then(registration => registration.active ?? undefined),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 10000); }),
        ]);
      } catch { return undefined; }
      finally { clearTimeout(timer); }
    })();
  }
  const current = useRef({ selected, chat, open, enabled });
  current.current = { selected, chat, open, enabled };

  function clear() {
    tracker.current.reset();
    generation.current++;
    void worker.current?.then(active => active?.postMessage({ type: 'clear-attention' }));
    for (const notification of notifications.current) notification.close();
    notifications.current.clear();
  }
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return () => clear();
    const receive = (event: MessageEvent) => {
      if (!current.current.enabled || event.origin !== location.origin) return;
      if (event.data?.type === 'open-attention' && typeof event.data.threadId === 'string') {
        current.current.open(event.data.threadId);
      } else if (event.data?.type === 'attention-error') setStatus('Notifications could not be displayed by this browser.');
    };
    navigator.serviceWorker.addEventListener('message', receive);
    return () => { navigator.serviceWorker.removeEventListener('message', receive); clear(); };
  }, []);
  useEffect(() => {
    pushEnabled.current = false;
    if (enabled && signedIn) pushSetup.current = pushSetup.current.then(enablePush).catch(() => setStatus('Background push is unavailable. Notifications require this page to stay connected.'));
  }, [enabled, signedIn]);

  async function toggle() {
    if (toggling.current) return;
    if (enabled) {
      toggling.current = true;
      current.current.enabled = false;
      setEnabled(false); clear();
      try {
        await pushSetup.current;
        const response = await fetch('/api/push', { method: 'DELETE' });
        if (!response.ok && response.status !== 503) throw new Error();
        pushEnabled.current = false;
      } catch {
        setEnabled(true);
        setStatus('Could not disable background notifications. Reconnect and try again.'); return;
      } finally { toggling.current = false; }
      try { localStorage.removeItem(preference); } catch { /* Session-only preference. */ }
      setStatus('');
      return;
    }
    if (!supported()) { setStatus('Browser notifications are unavailable here.'); return; }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus('Notifications are blocked or not allowed. Enable them in your browser’s site settings.');
        return;
      }
      setEnabled(true);
      try { localStorage.setItem(preference, 'true'); } catch { /* Session-only preference. */ }
      setStatus('Notifications work while this page stays open and connected.');
    } catch { setStatus('This browser could not enable notifications.'); }
  }

  async function notify(id: string, takeover = false) {
    if (!takeover && pushEnabled.current) return;
    const version = generation.current;
    const active = await prepareWorker();
    const view = current.current;
    if (version !== generation.current || !view.enabled || Notification.permission !== 'granted' ||
      (takeover ? document.visibilityState === 'visible' && document.hasFocus() : !chatNeedsAttention(id, view.selected, view.chat, document.visibilityState === 'visible', document.hasFocus()))) return;
    try {
      if (active) {
        active.postMessage({ type: 'show-attention', threadId: id, takeover });
        return;
      }
      setStatus('Using basic notifications; this browser may not bring the chat window forward.');
      const notification = new Notification('Nookframe needs your attention', {
        body: takeover ? 'Another slot requests this thread. Open Nookframe to allow takeover or keep it here.' : 'An agent run has ended. Open the conversation to review the result.', tag: `nookframe:${id}`,
      });
      notifications.current.add(notification);
      notification.onclose = () => notifications.current.delete(notification);
      notification.onclick = () => {
        notification.close(); notifications.current.delete(notification);
        window.focus(); current.current.open(id);
      };
    } catch { setStatus('Notifications could not be displayed by this browser.'); }
  }

  function update(threads: ThreadChoice[]) {
    for (const id of tracker.current.update(threads)) {
      const view = current.current;
      if (!view.enabled || !supported() || Notification.permission !== 'granted' ||
        !chatNeedsAttention(id, view.selected, view.chat, document.visibilityState === 'visible', document.hasFocus())) continue;
      void notify(id);
    }
  }

  function notifyTakeover(id: string) {
    if (current.current.enabled && supported() && Notification.permission === 'granted') void notify(id, true);
  }
  return { enabled, status, available: supported(), toggle, update, clear, notifyTakeover };
}
