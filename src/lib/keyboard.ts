/**
 * Global keyboard nav for the timeline. Registered once from AppShell.
 *
 * Keys:
 *   j / ArrowDown  → next row
 *   k / ArrowUp    → previous row
 *   h / ArrowLeft  → collapse current cascade group (future: no-op in v0.1)
 *   l / ArrowRight → expand current cascade group
 *   Enter          → open inspector for current row
 *   Esc            → close inspector
 *   ?              → toggle help overlay
 *   Cmd/Ctrl+Shift+R → toggle recording
 *
 * Ignores keydowns while an input/textarea/contenteditable has focus so the
 * user can type in filters without hijacking j/k.
 */

export type KbAction =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'collapse' }
  | { kind: 'expand' }
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'toggle-help' }
  | { kind: 'toggle-record' };

export function parseKeyEvent(e: KeyboardEvent): KbAction | null {
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;
    if (target.isContentEditable) return null;
  }

  // Record hotkey: Cmd/Ctrl + Shift + R. Check *before* the "no modifiers"
  // gate so it doesn't get filtered out.
  if (
    (e.metaKey || e.ctrlKey) &&
    e.shiftKey &&
    (e.code === 'KeyR' || e.key.toLowerCase() === 'r')
  ) {
    return { kind: 'toggle-record' };
  }

  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      return { kind: 'next' };
    case 'k':
    case 'ArrowUp':
      return { kind: 'prev' };
    case 'h':
    case 'ArrowLeft':
      return { kind: 'collapse' };
    case 'l':
    case 'ArrowRight':
      return { kind: 'expand' };
    case 'Enter':
      return { kind: 'open' };
    case 'Escape':
      return { kind: 'close' };
    case '?':
      return { kind: 'toggle-help' };
    default:
      return null;
  }
}

export function bindKeyboard(handler: (a: KbAction) => void): () => void {
  const listener = (e: KeyboardEvent): void => {
    const a = parseKeyEvent(e);
    if (!a) return;
    e.preventDefault();
    handler(a);
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
