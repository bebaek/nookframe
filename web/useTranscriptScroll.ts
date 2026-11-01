import { useLayoutEffect, useRef } from 'react';

/** Follow layout changes, not just incoming snapshots. */
export function useTranscriptScroll(active: boolean, threadId: string | undefined) {
  const transcript = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const geometry = useRef({ height: 0, viewport: 0, top: 0 });
  const readingAnchor = useRef<number | 'bottom' | null>(null);

  function preservePosition(keepBottom = false) {
    const el = transcript.current;
    if (!el) return;
    follow.current = false;
    // When controls return at the end, keep the last line above the composer.
    // Otherwise preserve the screen-space anchor without resuming auto-follow.
    readingAnchor.current = keepBottom && el.scrollHeight - el.scrollTop - el.clientHeight <= 1
      ? 'bottom' : el.scrollTop - el.getBoundingClientRect().top;
  }

  function sync() {
    const el = transcript.current;
    if (!el || !el.clientHeight) return; // Hidden terminal/chat tabs have no useful geometry.
    if (readingAnchor.current !== null) {
      el.scrollTop = readingAnchor.current === 'bottom'
        ? el.scrollHeight : readingAnchor.current + el.getBoundingClientRect().top;
      readingAnchor.current = null;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
    geometry.current = { height: el.scrollHeight, viewport: el.clientHeight, top: el.scrollTop };
  }

  useLayoutEffect(() => { follow.current = true; readingAnchor.current = null; }, [threadId]);
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
    // Layout-driven clamping or a redundant scroll event is not user intent.
    else if (el.scrollTop > previous.top && el.scrollHeight - el.scrollTop - el.clientHeight <= 1) follow.current = true;
    geometry.current.top = el.scrollTop;
  }

  function resume() {
    // Explicit send intent takes precedence over a pending reading anchor.
    readingAnchor.current = null;
    follow.current = true;
    sync();
  }

  return { transcript, content, onScroll, preservePosition, resume };
}
