/** web/ui/lib/Button.tsx — the one button, in the fills the panels use. See design-system.md. */
import type { JSX } from 'preact';

/** Filled is the one action on screen, outlined and text are its neighbours, danger is for the
 *  destructive row and the destructive confirmation. */
const FILLS = {
  filled: 'isa-btn--filled',
  outlined: 'isa-btn--outlined',
  text: 'isa-btn--text',
  danger: 'isa-btn--danger',
  dangerFilled: 'isa-btn--danger-filled',
} as const;

export type ButtonFill = keyof typeof FILLS;

/** Not a ref-forwarding component, deliberately: Preact gives a function component's ref its own
 *  wrapper rather than the DOM node, and a caller that wants the node to focus it has to hold a host
 *  element. `confirm.tsx` is that caller, and it writes the button out itself for the reason. */
export const Button = ({
  fill = 'filled',
  className,
  children,
  ...rest
}: JSX.IntrinsicElements['button'] & { fill?: ButtonFill }) => (
  // type defaults to "button": a button inside a form that nobody marked is a submit by default,
  // which turns "Cancel" into "send this".
  <button type="button" class={`isa-btn ${FILLS[fill]}${className ? ` ${className}` : ''}`} {...rest}>
    {children}
  </button>
);
