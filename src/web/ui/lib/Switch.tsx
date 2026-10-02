/** web/ui/lib/Switch.tsx — an on/off setting, as the real checkbox drawn as a Material switch. See design-system.md. */
export const Switch = ({
  id,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) => (
  // The INPUT is the switch: `appearance: none` in ui.css draws the track and thumb on it, so the
  // keyboard, the form and every assistive technology get the control they already understand.
  // `role="switch"` is what tells a screen reader this is on/off rather than checked/unchecked.
  <input
    id={id}
    class="isa-switch"
    type="checkbox"
    role="switch"
    checked={checked}
    disabled={disabled}
    onChange={event => onChange((event.target as HTMLInputElement).checked)}
  />
);
