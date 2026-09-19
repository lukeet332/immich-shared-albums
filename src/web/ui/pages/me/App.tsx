/** web/ui/pages/me/App.tsx — the per-user panel. Read-only "your shared albums" for now; the
 *  reunification/repair surfaces (matches, repair, pending requests) hang off this. See
 *  ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { t } from '../../lib/theme.ts';
import { myAlbums, myMatches, reunite, unreunite, type ActionableMatch, type MyAlbum } from './api.ts';

/** The admin panel, for a caller who can actually open it. A link an ordinary user cannot follow
 *  would bounce them to a sign-in page they will never pass. */
const ROUTE_PREFIX = '/immich-shared-albums';

export const App = () => {
  const [albums, setAlbums] = useState<MyAlbum[] | null>(null);
  const [household, setHousehold] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [matches, setMatches] = useState<ActionableMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reuniting, setReuniting] = useState('');
  const [detaching, setDetaching] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

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

  // The match carries the peer for display and the names for the pair; the ids the server needs
  // come from the same records it built the list from.
  /** One reload for both lists: they describe one state, and a mutation changes both. */
  const refreshBoth = async () => {
    const [freshMatches, freshAlbums] = await Promise.all([myMatches(), myAlbums()]);
    setMatches(freshMatches.matches);
    setAlbums(freshAlbums.albums);
  };

  const onReunite = async (m: ActionableMatch) => {
    if (!m.mappingId) return; // no share to reunite: this pairing has never been shared
    setReuniting(`${m.peer}:${m.mine.name}`);
    setNotice(null);
    try {
      const r = await reunite(m.mappingId, m.mine.name);
      setNotice(`Reunited into "${r.album}" — ${r.seeded} photo(s) were already there.`);
      // BOTH lists: a reunion moves a share out of the matches list and into the reunified one, so
      // refreshing only the matches leaves the albums below describing a state that no longer holds.
      await refreshBoth();
    } catch (e) {
      setNotice(`Could not reunite: ${(e as Error).message}`);
    } finally {
      setReuniting('');
    }
  };

  const onUnreunite = async (album: MyAlbum) => {
    setDetaching(album.mappingId);
    setNotice(null);
    try {
      const r = await unreunite(album.mappingId);
      setNotice(`"${r.left}" is yours again — ${r.purged} shared photo(s) removed from it.`);
      await refreshBoth(); // same reason, the other way round
    } catch (e) {
      setNotice(`Could not un-reunite: ${(e as Error).message}`);
    } finally {
      setDetaching('');
    }
  };

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
            <a href={`${ROUTE_PREFIX}/admin`} style={{ color: 'inherit' }}>
              🔗 Server settings and pairings →
            </a>
          </>
        )}
      </p>
      {notice && <div style={s.card}>{notice}</div>}
      {albums && albums.some(a => a.reunified) && (
        <section style={{ marginBottom: 22 }}>
          <b style={{ fontSize: 18 }}>Reunified albums</b>
          <p style={{ ...s.muted, marginTop: 6 }}>
            Albums you merged with another server. Leaving one keeps your album and your own photos, and
            removes only the photos that came from the other server.
          </p>
          <div style={s.card}>
            {albums
              .filter(a => a.reunified)
              .map(a => (
                <div style={s.item} key={a.mappingId}>
                  <div>{a.name}</div>
                  <div style={s.sub}>reunited with {a.peer}</div>
                  <button style={s.button} disabled={!!detaching} onClick={() => onUnreunite(a)}>
                    {detaching === a.mappingId ? 'Un-reuniting…' : 'Un-reunite (keep my album)'}
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}
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
                {m.mappingId ? (
                  <button style={s.button} disabled={!!reuniting} onClick={() => onReunite(m)}>
                    {reuniting === `${m.peer}:${m.mine.name}` ? 'Reuniting…' : 'Reunite these albums'}
                  </button>
                ) : (
                  // No share to reunite yet. An enabled button here would do nothing when clicked,
                  // because the handler has no mapping to act on — say what is missing instead.
                  <div style={s.muted}>Share this album with them in Immich, then reunite it here.</div>
                )}
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
