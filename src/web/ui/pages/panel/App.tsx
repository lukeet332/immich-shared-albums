/** web/ui/pages/panel/App.tsx — composition root of the admin panel. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { Confirm, type Confirmation } from '../../lib/confirm.tsx';
import { overview, unlinkPeer, type Overview, type Peer } from './api.ts';
import { LinkServer } from './LinkServer.tsx';
import { ConnectedServers } from './ConnectedServers.tsx';
import { SharedAlbums } from './SharedAlbums.tsx';
import { Settings } from './Settings.tsx';

export const App = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState<Confirmation | null>(null);
  const [unlinking, setUnlinking] = useState('');
  const [note, setNote] = useState('');

  const load = () =>
    overview()
      .then(setData)
      .catch(e => setError((e as Error).message));

  useEffect(() => {
    void load();
  }, []);

  const unlink = (peer: Peer) => {
    setAsking({
      title: `Unlink “${peer.name}”?`,
      body: 'Its photos and albums leave this server. Your own photos stay.',
      confirm: 'Unlink',
      danger: true,
      onConfirm: () => {
        // The dialog closes before this runs and the row stays listed until `load()` answers, so the
        // button has to be dead for the duration: the route does not deduplicate, and a second
        // request would come back "unknown household" and print an error over a success.
        setUnlinking(peer.pub);
        setNote('Unlinking…');
        unlinkPeer(peer.pub)
          .then(r => {
            setNote(`Unlinked ${r.household}.`);
            return load();
          })
          .catch((e: Error) => setNote(`Error: ${e.message}`))
          .finally(() => setUnlinking(''));
      },
    });
  };

  if (error) {
    return (
      <div class="isa-section">
        <h1 class="isa-page-title">Shared albums</h1>
        <p class="isa-note isa-note--error">
          Could not load: {error}. You may need to sign in to Immich as an admin.
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div class="isa-section">
        <h1 class="isa-page-title">Shared albums</h1>
        <p class="isa-page-lede">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <div class="isa-page-head">
        <h1 class="isa-page-title">🔗 Shared albums</h1>
        <span class="isa-page-household">· {data.household.name}</span>
      </div>
      <p class="isa-page-lede">
        Server-side settings and pairings. <a href="/immich-shared-albums/me">Your own shared albums →</a>
      </p>
      <LinkServer onLinked={load} />
      <SharedAlbums albums={data.albums} />
      <ConnectedServers peers={data.peers} onUnlink={unlink} unlinking={unlinking} note={note} />
      <Settings />
      <Confirm ask={asking} onClose={() => setAsking(null)} />
    </>
  );
};
