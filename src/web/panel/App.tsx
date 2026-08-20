/** web/panel/App.tsx — the admin panel shell and its data load. See ../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { styles, theme } from './theme.ts';
import { overview, type Overview } from './api.ts';
import { LinkServer } from './LinkServer.tsx';
import { ConnectedServers } from './ConnectedServers.tsx';
import { SharedAlbums } from './SharedAlbums.tsx';

export const App = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const load = () =>
    overview()
      .then(setData)
      .catch(e => setError((e as Error).message));

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <p style={{ ...styles.muted, color: theme.danger }}>
        Could not load: {error}. You may need to sign in to Immich as an admin.
      </p>
    );
  }
  if (!data) return <p style={styles.muted}>Loading…</p>;

  return (
    <>
      <h1 style={{ fontSize: 20, letterSpacing: '-.02em' }}>
        🔗 Shared albums <span style={{ color: theme.muted, fontWeight: 400 }}>· {data.household.name}</span>
      </h1>
      <LinkServer onLinked={load} />
      <SharedAlbums albums={data.albums} />
      <ConnectedServers peers={data.peers} onChange={load} />
    </>
  );
};
