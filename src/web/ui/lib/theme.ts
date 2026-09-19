/** web/ui/lib/theme.ts — Shared values, so colours and spacing are not repeated magic numbers across components. See ../../http-router.md. */
export const t = {
  bg: 'var(--isa-bg)',
  card: 'var(--isa-surface)',
  line: 'var(--isa-line)',
  text: 'var(--isa-ink)',
  muted: 'var(--isa-ink-muted)',
  accent: 'var(--isa-accent)',
  danger: 'var(--isa-danger)',
  radius: 18,
} as const;

/** One action's outcome, as the panel shows it: green for done, red for refused. */
export const toastStyle = (kind: 'ok' | 'error') =>
  kind === 'ok'
    ? {
        background: 'var(--isa-ok-surface)',
        border: '1px solid var(--isa-ok)',
        badge: 'var(--isa-ok)',
        glyph: '✓',
      }
    : {
        background: 'var(--isa-danger-surface)',
        border: '1px solid var(--isa-danger)',
        badge: 'var(--isa-danger)',
        glyph: '!',
      };

export const s = {
  /** Card and control shape, from the same tokens the stylesheets use. */
  radiusCard: 'var(--isa-radius-card)' as const,
  radiusControl: 'var(--isa-radius-control)' as const,
  font: 'var(--isa-font)' as const,
  /** Bottom-centre, like the snackbar people already know: it reports what just happened without
   *  moving anything they are reading. */
  toast: {
    position: 'fixed',
    left: '50%',
    bottom: 24,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    maxWidth: 'min(560px, calc(100vw - 32px))',
    padding: '12px 14px',
    borderRadius: 12,
    fontSize: 14,
    color: t.text,
    boxShadow: 'var(--isa-shadow-2)',
    zIndex: 20,
  },
  badge: {
    flex: 'none',
    width: 20,
    height: 20,
    borderRadius: 10,
    color: 'var(--isa-accent-ink)',
    fontSize: 13,
    fontWeight: 800,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismiss: {
    flex: 'none',
    marginLeft: 4,
    background: 'none',
    border: 0,
    color: 'inherit',
    opacity: 0.7,
    font: 'inherit',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
  },
  card: {
    background: t.card,
    border: `1px solid ${t.line}`,
    borderRadius: t.radius,
    padding: 18,
    margin: '14px 0',
  },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  item: { padding: '9px 0', borderBottom: `1px solid var(--isa-hairline)`, fontSize: 14 },
  muted: { color: t.muted, fontSize: 13 },
  sub: { color: t.muted, fontSize: 12 },
  input: {
    flex: 1,
    font: 'inherit',
    fontSize: 14,
    padding: '10px 12px',
    borderRadius: 11,
    border: `1px solid var(--isa-line)`,
    background: 'var(--isa-sunken)',
    color: 'inherit',
    outline: 'none',
    width: '100%',
  },
  button: {
    font: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    padding: '10px 18px',
    border: 0,
    borderRadius: 11,
    background: t.accent,
    color: 'var(--isa-surface)',
    cursor: 'pointer',
  },
  danger: {
    background: 'transparent',
    border: `1px solid var(--isa-focus-ring)`,
    color: t.danger,
    padding: '5px 12px',
    fontSize: 12,
    borderRadius: 11,
    cursor: 'pointer',
  },
  note: { fontSize: 13, marginTop: 10, color: 'var(--isa-accent-2)', minHeight: 18 },
} as const;
