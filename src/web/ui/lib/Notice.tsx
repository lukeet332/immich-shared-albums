/** web/ui/lib/Notice.tsx — the snackbar: what just happened, without moving what you were reading. See design-system.md. */
export const Notice = ({
  kind,
  text,
  onDismiss,
}: {
  kind: 'ok' | 'error';
  text: string;
  onDismiss: () => void;
}) => (
  // A success fades on its own; a failure stays until dismissed, because it is asking for
  // something. `alert` on a failure is what interrupts; a success waits its turn.
  <div
    id="notice"
    data-kind={kind}
    role={kind === 'ok' ? 'status' : 'alert'}
    aria-live={kind === 'ok' ? 'polite' : 'assertive'}
    class={`isa-notice isa-notice--${kind}`}
  >
    <span class="isa-notice-badge" aria-hidden="true">
      {kind === 'ok' ? '✓' : '!'}
    </span>
    <span class="isa-notice-text">{text}</span>
    <button class="isa-notice-dismiss" aria-label="Dismiss" onClick={onDismiss}>
      ×
    </button>
  </div>
);
