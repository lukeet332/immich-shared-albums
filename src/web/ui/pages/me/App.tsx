/** web/ui/pages/me/App.tsx — the per-user panel. Read-only "your shared albums" for now; the
 *  reunification/repair surfaces (matches, repair, pending requests) hang off this. See
 *  ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { t } from '../../lib/theme.ts';
import { myAlbums, myMatches, type MyAlbum, type PeerMatch } from './api.ts';

/** The admin panel, for a caller who can actually open it. A link an ordinary user cannot follow
 *  would bounce them to a sign-in page they will never pass. */
const ROUTE_PREFIX = '/immich-shared-albums';

export const App = () => {
  const [albums, setAlbums] = useState<MyAlbum[] | null>(null);
  const [household, setHousehold] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [matches, setMatches] = useState<PeerMatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    myAlbums()
      .then(r => {
        setAlbums(r.albums);
        setHousehold(r.household);
        setIsAdmin(r.isAdmin);
      })
      .catch(e => setError(e.message));
    // Its own request: a linked server being offline must not stop the albums above rendering.
    myMatches()
      .then(r => setMatches(r.matches))
      .catch(() => setMatches([]));
  }, []);

  return (
    <main>
      <h1 style={{ fontSize: 20, letterSpacing: '-.02em' }}>
        🔗 Shared albums
        <span style={{ color: t.muted, fontWeight: 400 }}> · {household || '…'}</span>
      </h1>
      <p style={{ ...s.muted, marginBottom: 4 }}>
        What you can see here is scoped to your own Immich account.
        {isAdmin && (
          <>
            {' '}
            <a href={`${ROUTE_PREFIX}/`} style={{ color: 'inherit' }}>
              🔗 Server settings and pairings →
            </a>
          </>
        )}
      </p>
      {matches.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <b style={{ fontSize: 18 }}>Possible album reunions</b>
          <p style={{ ...s.muted, marginTop: 6 }}>
            If you and someone on a linked server uploaded the same Google Photos album separately, you each
            ended up with half of it. These look like that — the same name, owned by a different person on
            each server. Reuniting them comes next, once both owners agree.
          </p>
          <div style={s.card}>
            {matches.map(m => (
              <div style={s.item} key={`${m.peer}:${m.mine.name}:${m.theirs.ownerName}`}>
                <div>{m.mine.name}</div>
                <div style={s.sub}>
                  yours: {m.mine.assetCount} {m.mine.assetCount === 1 ? 'photo' : 'photos'} ·{' '}
                  {m.theirs.ownerName} on {m.peerName}: {m.theirs.assetCount}{' '}
                  {m.theirs.assetCount === 1 ? 'photo' : 'photos'}
                  {m.sameDates ? ' · dates line up' : ''}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <b style={{ fontSize: 18 }}>Your shared albums</b>
      <p style={{ ...s.muted, marginTop: 6 }}>
        Albums shared between this server and a linked one that you're part of.
      </p>
      {error && <div style={s.card}>Couldn't load your albums: {error}</div>}
      {!error && albums === null && <div style={s.card}>Loading…</div>}
      {albums && albums.length === 0 && (
        <div style={s.card}>
          <span style={s.muted}>
            No shared albums yet. Share an album with a linked server to see it here.
          </span>
        </div>
      )}
      {albums && albums.length > 0 && (
        <div style={s.card}>
          {albums.map(a => (
            <div style={s.item} key={`${a.peer}:${a.name}`}>
              <div>{a.name}</div>
              <div style={s.sub}>
                {a.role === 'owner' ? 'shared by you' : 'shared with you'} · with {a.peer}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
};
