/** web/ui/lib/theme.ts — Shared values, so colours and spacing are not repeated magic numbers across components. See ../../http-router.md. */
export const t = {
  bg: '#101216',
  card: '#1f2229',
  line: 'rgba(255,255,255,.08)',
  text: '#e5e7eb',
  muted: '#6b7280',
  accent: '#4250af',
  danger: '#f87171',
  radius: 18,
} as const;

/** One action's outcome, as the panel shows it: green for done, red for refused. */
export const toastStyle = (kind: 'ok' | 'error') =>
  kind === 'ok'
    ? { background: '#0f2e22', border: '1px solid #1f7a5a', badge: '#34d399', glyph: '✓' }
    : { background: '#3a1d1d', border: '1px solid #a13b3b', badge: '#f87171', glyph: '!' };

export const s = {
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
    boxShadow: '0 10px 28px rgba(0,0,0,.45)',
    zIndex: 20,
  },
  badge: {
    flex: 'none',
    width: 20,
    height: 20,
    borderRadius: 10,
    color: '#0b0b0c',
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
  item: { padding: '9px 0', borderBottom: `1px solid rgba(255,255,255,.06)`, fontSize: 14 },
  muted: { color: t.muted, fontSize: 13 },
  sub: { color: t.muted, fontSize: 12 },
  input: {
    flex: 1,
    font: 'inherit',
    fontSize: 14,
    padding: '10px 12px',
    borderRadius: 11,
    border: `1px solid rgba(255,255,255,.12)`,
    background: '#15171c',
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
    color: '#fff',
    cursor: 'pointer',
  },
  danger: {
    background: 'transparent',
    border: `1px solid rgba(248,113,113,.45)`,
    color: t.danger,
    padding: '5px 12px',
    fontSize: 12,
    borderRadius: 11,
    cursor: 'pointer',
  },
  note: { fontSize: 13, marginTop: 10, color: '#8b9cf9', minHeight: 18 },
} as const;
