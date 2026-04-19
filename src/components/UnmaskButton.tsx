import type { ReactElement } from 'react';
/**
 * Renders a 🔓 Unmask button next to a redacted ledger entry. Plaintext result
 * lives in a `useRef` so it never enters React state (no re-render fan-out, no
 * devtools leak). A subscribe/notify fragment re-renders only this component.
 */

import { useRef, useState, useCallback, useEffect } from 'react';

import { apiPost } from '../lib/api';
import { useSelectionStore } from '../stores/selection';

type Props = {
  ledgerEntryId: string;
  /** Short redacted preview shown before unmask. */
  redacted: string | undefined;
};

type UnmaskResp = {
  ledgerEntryId: string;
  sessionId: string;
  plaintext: string;
  sourceFile: string;
  byteStart: number;
  byteEnd: number;
};

export function UnmaskButton({ ledgerEntryId, redacted }: Props): ReactElement {
  const plaintextRef = useRef<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const drawerOpen = useSelectionStore((s) => s.drawerOpen);

  // BUG-6: the inspector drawer is a CSS slide, not an unmount. Without this
  // reset, closing + reopening the same span would redisplay the previously
  // unmasked plaintext without any user gesture.
  useEffect(() => {
    if (!drawerOpen) {
      plaintextRef.current = null;
      setRevealed(false);
      setLoading(false);
      setErr(null);
    }
  }, [drawerOpen]);

  const onClick = useCallback(async (): Promise<void> => {
    if (revealed) {
      // Re-mask: drop the plaintext.
      plaintextRef.current = null;
      setRevealed(false);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const resp = await apiPost<UnmaskResp>(
        '/api/unmask',
        { ledgerEntryId },
        { 'X-Unmask-Confirm': '1' }
      );
      plaintextRef.current = resp.plaintext;
      setRevealed(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ledgerEntryId, revealed]);

  return (
    <div
      data-testid="unmask-container"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--peek-sp-2)',
        flexWrap: 'wrap',
        padding: '8px 0',
      }}
    >
      <code
        data-testid="unmask-text"
        className="peek-mono"
        style={{
          flex: 1,
          minWidth: 0,
          padding: '6px 8px',
          background: revealed ? 'rgba(232,106,106,0.06)' : 'var(--peek-bg)',
          border: `1px solid ${revealed ? 'var(--peek-bad)' : 'var(--peek-border)'}`,
          fontSize: 'var(--peek-fs-sm)',
          wordBreak: 'break-all',
          whiteSpace: 'pre-wrap',
        }}
      >
        {revealed ? (plaintextRef.current ?? '') : (redacted ?? '<secret>')}
      </code>
      <button
        type="button"
        onClick={(): void => {
          void onClick();
        }}
        disabled={loading}
        className="peek-mono"
        style={{
          fontSize: 'var(--peek-fs-xs)',
          padding: '4px 8px',
          border: `1px solid ${revealed ? 'var(--peek-bad)' : 'var(--peek-border)'}`,
          color: revealed ? 'var(--peek-bad)' : 'var(--peek-fg-dim)',
          background: 'transparent',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {loading ? '…' : revealed ? '🔒 mask' : '🔓 unmask'}
      </button>
      {revealed && (
        <div
          role="alert"
          style={{
            flexBasis: '100%',
            fontSize: 'var(--peek-fs-xs)',
            color: 'var(--peek-warn)',
          }}
        >
          Unmasked content is in browser memory.
        </div>
      )}
      {err !== null && (
        <div
          role="alert"
          style={{ flexBasis: '100%', fontSize: 'var(--peek-fs-xs)', color: 'var(--peek-bad)' }}
        >
          {err}
        </div>
      )}
    </div>
  );
}
