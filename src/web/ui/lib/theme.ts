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
    borderRadius: 'var(--isa-radius-pill)',
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
    borderRadius: 'var(--isa-radius-card)',
    padding: 'var(--isa-pad-card)',
    margin: '14px 0',
  },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  /** One row: what it is on the left, what you can do about it on the right, and the action drops
   *  below only when the text needs the width — a phone in portrait, or a long album name. */
  item: {
    padding: 'var(--isa-space-4) 0',
    borderBottom: `1px solid var(--isa-hairline)`,
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--isa-space-3)',
    flexWrap: 'wrap',
  },
  grow: { flex: '1 1 220px', minWidth: 0 },
  /** A row that goes somewhere: the whole thing is the target, and the chevron says so. */
  choice: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--isa-space-3)',
    padding: 'var(--isa-space-4) 0',
    fontSize: 14,
  },
  chevron: {
    flex: 'none',
    color: 'var(--isa-ink-subtle, var(--isa-ink-muted))',
    fontSize: 18,
    lineHeight: 1,
  },
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'var(--isa-scrim)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--isa-space-4)',
    zIndex: 30,
  },
  dialog: {
    background: 'var(--isa-surface)',
    borderRadius: 'var(--isa-radius-card)',
    boxShadow: 'var(--isa-shadow-1), var(--isa-shadow-2)',
    padding: 'var(--isa-pad-card)',
    width: '100%',
    maxWidth: 380,
  },
  dialogBody: {
    color: 'var(--isa-ink-muted)',
    fontSize: 13.5,
    lineHeight: 1.5,
    margin: '6px 0 var(--isa-space-5)',
  },
  dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--isa-space-2)' },
  buttonQuiet: {
    flex: 'none',
    minHeight: 40,
    font: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    padding: '10px 18px',
    border: '1px solid var(--isa-line)',
    borderRadius: 'var(--isa-radius-pill)',
    background: 'none',
    color: 'var(--isa-ink)',
    cursor: 'pointer',
  },
  /** Destructive in a LIST: tonal, so a page of rows is not a wall of red. The filled form is for a
   *  confirmation, where the action is the only thing on screen. */
  buttonDangerTonal: { background: 'var(--isa-danger-surface)', color: 'var(--isa-danger)' },
  buttonDanger: { background: 'var(--isa-danger)', color: 'var(--isa-surface)' },
  /** A row's own rhythm: what it is, what it is made of, what you can do about it — 4px apart. */
  title: { fontSize: 15, fontWeight: 600, letterSpacing: '-.01em' },
  /** A real `<h2>`, reset to the page's own type: the padding/margins a heading element brings would
   *  otherwise land on top of the rhythm above. */
  h2: {
    display: 'block',
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 'inherit',
    margin: 'var(--isa-space-6) 0 var(--isa-space-2)',
    padding: 0,
  },
  muted: { color: t.muted, fontSize: 13 },
  sub: { color: t.muted, fontSize: 12 },
  input: {
    flex: 1,
    font: 'inherit',
    fontSize: 14,
    padding: '10px 12px',
    borderRadius: 'var(--isa-radius-pill)',
    border: `1px solid var(--isa-line)`,
    background: 'var(--isa-sunken)',
    color: 'inherit',
    outline: 'none',
    width: '100%',
  },
  button: {
    flex: 'none',
    minHeight: 40,
    font: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    padding: '10px 18px',
    border: 0,
    borderRadius: 'var(--isa-radius-pill)',
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
    borderRadius: 'var(--isa-radius-pill)',
    cursor: 'pointer',
  },
  note: { fontSize: 13, marginTop: 10, color: 'var(--isa-accent-2)', minHeight: 18 },
} as const;
