/** web/ui/lib/Notice.tsx — the snackbar: what just happened, without moving what you were reading. See design-system.md. */
import { useEffect, useRef, useState } from 'preact/hooks';

/** How far the bar has to travel before letting go counts as a dismissal, whichever is smaller:
 *  a third of the way across it, or a thumb's width. */
const SWIPE_DISMISS_PX = 96;
const SWIPE_DISMISS_FRACTION = 0.34;

export const Notice = ({
  kind,
  text,
  onDismiss,
}: {
  kind: 'ok' | 'error';
  text: string;
  onDismiss: () => void;
}) => {
  const bar = useRef<HTMLDivElement>(null);
  const swipe = useRef({ from: 0, width: 0, live: false });
  const [grabbing, setGrabbing] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!leaving) return;
    // The ANIMATION is what unmounts it, so the bar is still on screen while it fades. Timing the
    // unmount instead would hold a dismissed message for 220ms even under reduced motion.
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.animationName === 'isa-notice-out') onDismiss();
    };
    const node = bar.current;
    node?.addEventListener('animationend', onAnimationEnd);
    return () => node?.removeEventListener('animationend', onAnimationEnd);
  }, [leaving, onDismiss]);

  // Escape is the keyboard's swipe: a bar that can only be dismissed with a pointer is a bar a
  // keyboard user is stuck with.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLeaving(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  /** Pointer events cover the finger and the mouse in one path; the intent is a HORIZONTAL drag,
   *  so a vertical one is left to the page. */
  const onPointerDown = (event: PointerEvent) => {
    if (leaving || !bar.current) return;
    swipe.current = { from: event.clientX, width: bar.current.offsetWidth, live: true };
    bar.current.setPointerCapture(event.pointerId);
    setGrabbing(true);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!swipe.current.live || !bar.current) return;
    const travelled = event.clientX - swipe.current.from;
    bar.current.style.setProperty('--notice-drag', `${travelled}px`);
    bar.current.style.setProperty('--notice-dim', String(Math.max(0.3, 1 - Math.abs(travelled) / 260)));
  };

  const onPointerUp = () => {
    if (!swipe.current.live || !bar.current) return;
    swipe.current.live = false;
    const travelled = parseFloat(bar.current.style.getPropertyValue('--notice-drag')) || 0;
    const gone =
      Math.abs(travelled) > Math.min(SWIPE_DISMISS_PX, swipe.current.width * SWIPE_DISMISS_FRACTION);
    setGrabbing(false);
    // Clearing the offset hands the bar back to its resting place; the transition eases it there.
    if (gone) return setLeaving(true);
    bar.current.style.setProperty('--notice-drag', '0px');
    bar.current.style.setProperty('--notice-dim', '1');
  };

  return (
    <div
      id="notice"
      ref={bar}
      data-kind={kind}
      role={kind === 'ok' ? 'status' : 'alert'}
      aria-live={kind === 'ok' ? 'polite' : 'assertive'}
      class={`isa-notice isa-notice--${kind}${grabbing ? ' isa-notice--grabbing' : ''}${
        leaving ? ' isa-notice--leaving' : ''
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span class="isa-notice-badge" aria-hidden="true">
        {kind === 'ok' ? '✓' : '!'}
      </span>
      <span class="isa-notice-text">{text}</span>
      <button type="button" class="isa-notice-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
};
