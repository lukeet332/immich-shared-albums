/** web/ui/lib/Card.tsx — the box a page's content sits in, and the line under it that says what it is for. See design-system.md. */
import type { ComponentChildren } from 'preact';

export const Card = ({
  lede,
  children,
}: {
  /** What the card is FOR, when the section title above it is not the whole story. */
  lede?: string;
  children?: ComponentChildren;
}) => (
  <section class="isa-card isa-enter">
    {lede && <p class="isa-card-lede">{lede}</p>}
    {children}
  </section>
);
