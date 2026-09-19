/** web/ui/pages/root/App.tsx — the one URL to remember: it decides which panel to open. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { myAlbums } from '../me/api.ts';

const ROUTE_PREFIX = '/immich-shared-albums';

/**
 * The root is a chooser, not a panel: an admin picks between their own albums and the server's, and
 * everyone else goes straight to their own. It asks Immich who is calling (the same call the panels
 * make) rather than being gated on admin, because gating a landing page on `isAdmin` answers an
 * ordinary user with a sign-in page — the memorable URL is the one they would have typed.
 */
export const App = () => {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    myAlbums()
      .then(r => {
        // No choice to offer, so do not make one: their panel renders at /me either way.
        if (!r.isAdmin) location.replace(`${ROUTE_PREFIX}/me`);
        else setIsAdmin(true);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed)
    return (
      <div style={s.card}>
        Could not reach this server. <a href={`${ROUTE_PREFIX}/me`}>Open your shared albums</a>.
      </div>
    );
  if (isAdmin === null) return <div style={s.card}>Loading…</div>;

  return (
    <>
      <h1 style={{ fontSize: 20, letterSpacing: '-.02em' }}>🔗 Shared albums</h1>
      <div style={s.card}>
        <a
          href={`${ROUTE_PREFIX}/me`}
          className="choice"
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          <div style={s.grow}>
            <div style={s.title}>Your shared albums</div>
            <div style={s.sub}>Albums you share across servers</div>
          </div>
          <span style={s.chevron}>›</span>
        </a>
        <a
          href={`${ROUTE_PREFIX}/admin`}
          className="choice"
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          <div style={s.grow}>
            <div style={s.title}>Server settings and pairings</div>
            <div style={s.sub}>Linked servers, pairing, and this server's sharing settings · admins only</div>
          </div>
          <span style={s.chevron}>›</span>
        </a>
      </div>
    </>
  );
};
