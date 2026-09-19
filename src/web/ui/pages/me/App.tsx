/** web/ui/pages/me/App.tsx — the per-user panel: your shared albums, the possible reunions and what
 *  can be done about each one, and the albums you have reunited. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s, t, toastStyle } from '../../lib/theme.ts';
import {
  invite,
  myAlbums,
  myMatches,
  reunite,
  unreunite,
  type ActionableMatch,
  type MyAlbum,
} from './api.ts';

/** The admin panel, for a caller who can actually open it. A link an ordinary user cannot follow
 *  would bounce them to a sign-in page they will never pass. */
const ROUTE_PREFIX = '/immich-shared-albums';

/** One row's identity: two candidates that agree on all of this are the same row (`asOneRow` on the
 *  server collapses them), so it is also what React needs to keep them apart. */
const rowKey = (m: ActionableMatch) =>
  `${m.peer}:${m.mine.name}:${m.theirs.ownerName}:${m.theirs.assetCount}:${m.theirs.startDate ?? ''}:${m.theirs.endDate ?? ''}`;

export const App = () => {
  const [albums, setAlbums] = useState<MyAlbum[] | null>(null);
  const [household, setHousehold] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [matches, setMatches] = useState<ActionableMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reuniting, setReuniting] = useState('');
  const [inviting, setInviting] = useState('');
  const [detaching, setDetaching] = useState('');
  // An action's outcome, kept apart from the lists it describes: `kind` is what makes "done" and
  // "refused" look different, which a bare string could not.
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

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
  /** One reload for both lists: they describe one state, and a mutation changes both.
   *
   *  Settled INDEPENDENTLY. `Promise.all` rejects the pair if either read fails, which would report a
   *  mutation that succeeded as a failure and leave both lists showing the state before it. */
  const refreshBoth = async () => {
    const [freshMatches, freshAlbums] = await Promise.allSettled([myMatches(), myAlbums()]);
    if (freshMatches.status === 'fulfilled') setMatches(freshMatches.value.matches);
    if (freshAlbums.status === 'fulfilled') setAlbums(freshAlbums.value.albums);
  };

  const NOTICE_MS = 6000;

  // A success fades; a failure stays, because it is asking for something.
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const onReunite = async (m: ActionableMatch) => {
    if (!m.mappingId) return; // no share to reunite: this pairing has never been shared
    setReuniting(rowKey(m));
    setNotice(null);
    try {
      const r = await reunite(m.mappingId, m.mine.name);
      setNotice({
        kind: 'ok',
        text: `Reunited into "${r.album}" — ${r.seeded} photo(s) were already there.`,
      });
      // BOTH lists: a reunion moves a share out of the matches list and into the reunified one, so
      // refreshing only the matches leaves the albums below describing a state that no longer holds.
      await refreshBoth();
    } catch (e) {
      setNotice({ kind: 'ok', text: `Could not reunite: ${(e as Error).message}` });
    } finally {
      setReuniting('');
    }
  };

  /** Share MY album with them, which is what a reunion starts from. The server does the membership;
   *  the other person then sees this pairing as an invitation they can accept. */
  const onInvite = async (m: ActionableMatch) => {
    setInviting(rowKey(m));
    setNotice(null);
    try {
      const r = await invite(m.peer, m.mine.name, m.theirs.ownerUserId);
      setNotice({
        kind: 'ok',
        text: `Invited ${r.invited} to reunite “${r.album}” — it is now in their panel to accept.`,
      });
      await refreshBoth();
    } catch (e) {
      setNotice({ kind: 'ok', text: `Could not invite: ${(e as Error).message}` });
    } finally {
      setInviting('');
    }
  };

  const onUnreunite = async (album: MyAlbum) => {
    setDetaching(album.mappingId);
    setNotice(null);
    try {
      const r = await unreunite(album.mappingId);
      setNotice({
        kind: 'ok',
        text: `"${r.left}" is yours again — ${r.purged} shared photo(s) removed from it.`,
      });
      await refreshBoth(); // same reason, the other way round
    } catch (e) {
      setNotice({ kind: 'ok', text: `Could not un-reunite: ${(e as Error).message}` });
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
      {notice && (
        // A snackbar: it says what just happened without moving what the person is reading. Success
        // fades on its own; a failure stays until dismissed, because it is asking for something.
        <div
          id="notice"
          data-kind={notice.kind}
          role={notice.kind === 'ok' ? 'status' : 'alert'}
          aria-live={notice.kind === 'ok' ? 'polite' : 'assertive'}
          style={{ ...s.toast, ...toastStyle(notice.kind) }}
        >
          <span style={{ ...s.badge, background: toastStyle(notice.kind).badge }}>
            {toastStyle(notice.kind).glyph}
          </span>
          <span>{notice.text}</span>
          <button style={s.dismiss} aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      {albums && albums.some(a => a.reunified) && (
        <section style={{ marginBottom: 22 }}>
          <b style={s.h2}>Reunified albums</b>
          <p style={{ ...s.muted, marginTop: 6 }}>
            Albums you merged with another server. Leaving one keeps your album and your own photos, and
            removes only the photos that came from the other server.
          </p>
          <div style={s.card}>
            {albums
              .filter(a => a.reunified)
              .map(a => (
                <div style={s.item} key={a.mappingId}>
                  <div style={s.title}>{a.name}</div>
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
          <b style={s.h2}>Possible album reunions</b>
          <p style={{ ...s.muted, marginTop: 6 }}>
            If you and someone on a linked server uploaded the same Google Photos album separately, you each
            ended up with half of it. These look like that — the same name, owned by a different person on
            each server. <b>Invite</b> shares your album with them so they can accept it; if they invited you,{' '}
            <b>Accept invite</b> merges their half into the album you already own. It stays yours either way,
            and you can undo it.
          </p>
          <div style={s.card}>
            {matches.map(m => (
              <div style={s.item} key={rowKey(m)}>
                <div style={s.title}>{m.mine.name}</div>
                <div style={s.sub}>
                  yours: {m.mine.assetCount} {m.mine.assetCount === 1 ? 'photo' : 'photos'} ·{' '}
                  {m.theirs.ownerName} on {m.peerName}: {m.theirs.assetCount}{' '}
                  {m.theirs.assetCount === 1 ? 'photo' : 'photos'}
                  {m.sameDates ? ' · dates line up' : ''}
                </div>
                {m.step.kind === 'invite' && (
                  // Nothing shared between the two of you yet. This shares MY album with them, the
                  // same membership Immich's own picker makes — so the reunion can start from here.
                  <button style={s.button} disabled={!!inviting} onClick={() => onInvite(m)}>
                    {inviting === rowKey(m) ? 'Inviting…' : `Invite ${m.theirs.ownerName}`}
                  </button>
                )}
                {m.step.kind === 'accept' && (
                  <button style={s.button} disabled={!!reuniting} onClick={() => onReunite(m)}>
                    {reuniting === rowKey(m) ? 'Reuniting…' : 'Accept invite'}
                  </button>
                )}
                {m.step.kind === 'waiting' && (
                  // I shared mine with them; adopting my own album is not an adoption at all, so
                  // there is nothing to click until they accept on their side.
                  <div style={s.muted}>
                    Invited {m.theirs.ownerName} — waiting for them to accept in their panel.
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <b style={s.h2}>Your shared albums</b>
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
              <div style={s.title}>{a.name}</div>
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
