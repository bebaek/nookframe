import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

// Recall text only: attachments must never be silently re-sent.
export function useInputHistory(threadId: string | undefined, draft: string, messages: { role: string; text: string }[], setDraft: (text: string) => void) {
  const browsing = useRef<{ entries: string[]; index: number; saved: string } | undefined>(undefined);
  const caret = useRef<{ input: HTMLTextAreaElement; position: number } | undefined>(undefined);
  const reset = () => { browsing.current = undefined; caret.current = undefined; };
  useLayoutEffect(reset, [threadId]);
  useLayoutEffect(() => {
    if (caret.current) {
      const { input, position } = caret.current;
      input.setSelectionRange(position, position);
      caret.current = undefined;
    }
  }, [draft]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const input = event.currentTarget;
    const up = event.key === 'ArrowUp';
    // Preserve selections and normal multiline cursor movement. Single-line
    // prompts can be recalled regardless of the cursor's horizontal position.
    if (input.selectionStart !== input.selectionEnd ||
      (draft.includes('\n') && (up ? input.selectionStart !== 0 : input.selectionEnd !== draft.length))) return;
    let history = browsing.current;
    if (!history) {
      if (!up) return;
      const entries = messages.filter(message => message.role === 'user' && message.text.trim()).map(message => message.text);
      if (!entries.length) return;
      history = browsing.current = { entries, index: entries.length, saved: draft };
    }
    event.preventDefault();
    if (event.repeat) return;
    history.index = Math.max(0, Math.min(history.entries.length, history.index + (up ? -1 : 1)));
    const text = history.entries[history.index] ?? history.saved;
    const position = up ? 0 : text.length;
    if (text === draft) input.setSelectionRange(position, position);
    else {
      caret.current = { input, position };
      setDraft(text);
    }
    if (history.index === history.entries.length) browsing.current = undefined;
  }
  return { onKeyDown, reset };
}
