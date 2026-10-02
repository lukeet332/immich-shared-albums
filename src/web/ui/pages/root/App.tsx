/** web/ui/pages/root/App.tsx — the one URL to remember: it decides which panel to open. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { Card } from '../../lib/Card.tsx';
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
      <Card>
        Could not reach this server. <a href={`${ROUTE_PREFIX}/me`}>Open your shared albums</a>.
      </Card>
    );
  if (isAdmin === null) return <Card>Loading…</Card>;

  return (
    <>
      <div class="isa-page-head">
        <h1 class="isa-page-title">🔗 Shared albums</h1>
      </div>
      <Card>
        {/* `choice` alongside `isa-choice` is a TEST CONTRACT — the browser lane asserts on a.choice. */}
        <a href={`${ROUTE_PREFIX}/me`} class="isa-choice choice">
          <span class="isa-row-main">
            <span class="isa-row-title">Your shared albums</span>
            <span class="isa-row-sub">Albums you share across servers</span>
          </span>
          <span class="isa-chevron">›</span>
        </a>
        <a href={`${ROUTE_PREFIX}/admin`} class="isa-choice choice">
          <span class="isa-row-main">
            <span class="isa-row-title">Server settings and pairings</span>
            <span class="isa-row-sub">Linked servers, pairing, and this server's settings · admins only</span>
          </span>
          <span class="isa-chevron">›</span>
        </a>
      </Card>
    </>
  );
};
