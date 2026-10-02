/** web/ui/lib/Setting.tsx — one row of a settings list: what it is, what it does, the control. See design-system.md. */
import type { ComponentChildren } from 'preact';

export const Setting = ({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  /** The control that changes it — a Switch, or a select. */
  children: ComponentChildren;
}) => (
  <label class="isa-setting">
    <span class="isa-setting-text">
      <span class="isa-setting-label">{label}</span>
      {description && <span class="isa-setting-description">{description}</span>}
    </span>
    {children}
  </label>
);
