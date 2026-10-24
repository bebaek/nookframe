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
  const current = useRef({ selected, chat, open, enabled });
  current.current = { selected, chat, open, enabled };

  function clear() {
    tracker.current.reset();
    for (const notification of notifications.current) notification.close();
    notifications.current.clear();
  }
  useEffect(() => clear, []);

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

  function update(threads: ThreadChoice[]) {
    for (const id of tracker.current.update(threads)) {
      const view = current.current;
      if (!view.enabled || !supported() || Notification.permission !== 'granted' ||
        !chatNeedsAttention(id, view.selected, view.chat, document.visibilityState === 'visible', document.hasFocus())) continue;
      try {
        // Do not expose conversation titles, responses, or tool output on the lock screen.
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
  }

  return { enabled, status, available: supported(), toggle, update, clear };
}
