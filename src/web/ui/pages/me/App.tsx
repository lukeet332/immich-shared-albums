/** web/ui/pages/me/App.tsx — the per-user panel. Read-only "your shared albums" for now; the
 *  reunification/repair surfaces (matches, repair, pending requests) hang off this. See
 *  ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { myAlbums, type MyAlbum } from './api.ts';

export const App = () => {
  const [albums, setAlbums] = useState<MyAlbum[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    myAlbums()
      .then(r => setAlbums(r.albums))
      .catch(e => setError(e.message));
  }, []);

  return (
    <main>
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
