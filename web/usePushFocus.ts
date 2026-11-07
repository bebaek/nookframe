import { useEffect } from 'react';
import type { ClientCommand } from '../shared/protocol';

export function usePushFocus(socket: WebSocket | null, connected: boolean, threadId: string | undefined, chat: boolean) {
  useEffect(() => {
    if (!connected || !socket) return;
    function report(leaving = false) {
      if (socket!.readyState !== WebSocket.OPEN) return;
      const message: ClientCommand = { type: 'push_focus', threadId: threadId ?? '',
        focused: !leaving && chat && document.visibilityState === 'visible' && document.hasFocus() };
      socket!.send(JSON.stringify(message));
    }
    const changed = () => report();
    const leaving = () => report(true);
    report();
    const timer = setInterval(changed, 15000);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('focus', changed);
    window.addEventListener('blur', leaving);
    window.addEventListener('pagehide', leaving);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('focus', changed);
      window.removeEventListener('blur', leaving);
      window.removeEventListener('pagehide', leaving);
      report(true);
    };
  }, [socket, connected, threadId, chat]);
}
