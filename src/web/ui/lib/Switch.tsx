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
  // The INPUT is the switch: ui.css draws the track and the thumb on it with appearance:none, and
  // role="switch" is what announces it as on/off rather than checked/unchecked.
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
