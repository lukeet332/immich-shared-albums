/** web/ui/lib/confirm.tsx — the one confirmation every action asks through. See ../../http-router.md. */
import { useEffect, useRef } from 'preact/hooks';
import { s } from './theme.ts';

export type Confirmation = {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
};

/** A dialog, or nothing. Confirming runs the action; the caller does not have to remember to close. */
export const Confirm = ({ ask, onClose }: { ask: Confirmation | null; onClose: () => void }) => {
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ask) return;
    confirmButton.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [ask]);
  if (!ask) return null;
  return (
    <div style={s.scrim} onClick={onClose}>
      <div
        style={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={ask.title}
        onClick={e => e.stopPropagation()}
      >
        <div style={s.title}>{ask.title}</div>
        <p style={s.dialogBody}>{ask.body}</p>
        <div style={s.dialogActions}>
          <button style={s.buttonQuiet} onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmButton}
            style={{ ...s.button, ...(ask.danger ? s.buttonDanger : {}) }}
            onClick={() => {
              onClose();
              ask.onConfirm();
            }}
          >
            {ask.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};
