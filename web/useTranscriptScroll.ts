import { useLayoutEffect, useRef } from 'react';

/** Follow layout changes, not just incoming snapshots. */
export function useTranscriptScroll(active: boolean, threadId: string | undefined) {
  const transcript = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const geometry = useRef({ height: 0, viewport: 0, top: 0 });

  function sync() {
    const el = transcript.current;
    if (!el || !el.clientHeight) return; // Hidden terminal/chat tabs have no useful geometry.
    if (follow.current) el.scrollTop = el.scrollHeight;
    geometry.current = { height: el.scrollHeight, viewport: el.clientHeight, top: el.scrollTop };
  }

  useLayoutEffect(() => { follow.current = true; }, [threadId]);
  useLayoutEffect(() => { if (active) sync(); });
  useLayoutEffect(() => {
    const el = transcript.current, body = content.current;
    if (!active || !el || !body) return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    observer.observe(body);
    return () => observer.disconnect();
  }, [active]);

  function onScroll() {
    const el = transcript.current;
    if (!el || !el.clientHeight) return;
    const previous = geometry.current;
    // Browser layout/anchoring events must not revoke follow before ResizeObserver runs.
    if (previous.height !== el.scrollHeight || previous.viewport !== el.clientHeight) {
      sync();
      return;
    }
    // Even a small upward scroll means the user is reading. Only resume at
    // the bottom, not within a broad threshold that can steal their position.
    if (el.scrollTop < previous.top) follow.current = false;
    else if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) follow.current = true;
    geometry.current.top = el.scrollTop;
  }

  return { transcript, content, onScroll };
}
