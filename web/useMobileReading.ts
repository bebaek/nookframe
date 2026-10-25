import { useEffect, useRef, useState, type RefObject, type TouchEvent, type WheelEvent } from 'react';

/** Browser-like chrome, driven by gestures rather than programmatic scrolling. */
export function useMobileReading(enabled: boolean, threadId: string | undefined, pinned: boolean,
  transcript: RefObject<HTMLElement | null>, preservePosition: () => void) {
  const [mobile, setMobile] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [hiddenThread, setHiddenThread] = useState<string>();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const motion = useRef({ amount: 0, time: 0 });
  const hidden = mobile && enabled && !pinned && !keyboard && hiddenThread !== undefined && hiddenThread === threadId;

  function show() { setHiddenThread(undefined); motion.current.amount = 0; }

  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)');
    const update = () => { setMobile(media.matches); setHiddenThread(undefined); };
    update();
    media.addEventListener('change', update);
    const viewport = window.visualViewport;
    const resize = () => setKeyboard(!!viewport && window.innerHeight - viewport.height > 120);
    resize();
    viewport?.addEventListener('resize', resize);
    return () => { media.removeEventListener('change', update); viewport?.removeEventListener('resize', resize); };
  }, []);

  useEffect(() => { show(); touch.current = null; }, [enabled, threadId, pinned, keyboard]);

  function gesture(dx: number, dy: number) {
    const el = transcript.current;
    if (!mobile || !enabled || pinned || keyboard || !el || threadId === undefined ||
      document.querySelector(':popover-open') || Math.abs(dx) >= Math.abs(dy)) return;
    const now = performance.now();
    const previous = motion.current;
    const amount = now - previous.time > 200 || Math.sign(previous.amount) !== Math.sign(dy) ? dy : previous.amount + dy;
    motion.current = { amount, time: now };
    // Ignore downward overscroll at the bottom and non-scrollable transcripts.
    if (!hidden && amount >= 48 && el.scrollHeight - el.clientHeight - el.scrollTop > 1) {
      preservePosition();
      setHiddenThread(threadId);
      motion.current.amount = 0;
    } else if (hidden && amount <= -12) {
      preservePosition();
      show();
    }
  }

  function onTouchStart(event: TouchEvent) {
    motion.current.amount = 0;
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    touch.current = point ? { x: point.clientX, y: point.clientY } : null;
  }
  function onTouchMove(event: TouchEvent) {
    const point = event.touches.length === 1 ? event.touches[0] : undefined;
    const previous = touch.current;
    if (!point) { touch.current = null; return; }
    touch.current = { x: point.clientX, y: point.clientY };
    if (previous) gesture(previous.x - point.clientX, previous.y - point.clientY);
  }
  function onWheel(event: WheelEvent) {
    if (event.ctrlKey) return; // Pinch zoom is not a reading gesture.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? transcript.current?.clientHeight ?? 1 : 1;
    gesture(event.deltaX * scale, event.deltaY * scale);
  }
  function reveal() { if (hidden) preservePosition(); show(); }

  return { hidden, show, reveal, gestures: { onTouchStart, onTouchMove, onTouchEnd: () => { touch.current = null; }, onTouchCancel: () => { touch.current = null; }, onWheel } };
}
