import { useEffect, useRef, useState } from 'react';
import type { ThreadChoice } from '../shared/protocol';
import { AttentionTracker, chatNeedsAttention } from './attention';

const preference = 'nookframe.attentionNotifications';
const supported = () => typeof Notification !== 'undefined' && window.isSecureContext;

export function useAttentionNotifications(selected: string | undefined, chat: boolean, open: (id: string) => void) {
  const [enabled, setEnabled] = useState(() => {
    try { return supported() && Notification.permission === 'granted' && localStorage.getItem(preference) === 'true'; }
    catch { return false; }
  });
  const [status, setStatus] = useState('');
  const tracker = useRef(new AttentionTracker());
  const notifications = useRef(new Set<Notification>());
  const worker = useRef<Promise<ServiceWorker | undefined> | undefined>(undefined);
  const generation = useRef(0);

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
  useEffect(() => { if (enabled) void prepareWorker(); }, [enabled]);

  async function toggle() {
    if (enabled) {
      current.current.enabled = false;
      setEnabled(false); clear();
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

  async function notify(id: string) {
    const version = generation.current;
    const active = await prepareWorker();
    const view = current.current;
    if (version !== generation.current || !view.enabled || Notification.permission !== 'granted' ||
      !chatNeedsAttention(id, view.selected, view.chat, document.visibilityState === 'visible', document.hasFocus())) return;
    try {
      if (active) {
        active.postMessage({ type: 'show-attention', threadId: id });
        return;
      }
      setStatus('Using basic notifications; this browser may not bring the chat window forward.');
      const notification = new Notification('Nookframe needs your attention', {
        body: 'An agent run has ended. Open the conversation to review the result.', tag: `nookframe:${id}`,
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

  return { enabled, status, available: supported(), toggle, update, clear };
}
