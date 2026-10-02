/** web/ui/lib/confirm.tsx — the one confirmation every action asks through. See design-system.md. */
import { useEffect, useRef } from 'preact/hooks';
import { Button } from './Button.tsx';

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
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!ask) return;
    // Where focus was, so dismissing puts it back: a dialog that eats the caret strands a keyboard
    // user at the top of the page with no way to tell what they were on.
    opener.current = document.activeElement;
    confirmButton.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [ask]);
  if (!ask) return null;
  return (
    <div class="isa-scrim" onClick={onClose}>
      <div
        class="isa-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ask.title}
        onClick={e => e.stopPropagation()}
      >
        <div class="isa-dialog-title">{ask.title}</div>
        <p class="isa-dialog-body">{ask.body}</p>
        <div class="isa-dialog-actions">
          <Button fill="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            ref={confirmButton}
            fill={ask.danger ? 'dangerFilled' : 'filled'}
            onClick={() => {
              onClose();
              ask.onConfirm();
            }}
          >
            {ask.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
};
