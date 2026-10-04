/** web/ui/pages/panel/App.tsx — composition root of the admin panel. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { followServerHints } from '../../lib/live.ts';
import { useAnnouncer } from '../../lib/announce.ts';
import { Card } from '../../lib/Card.tsx';
import { Notice } from '../../lib/Notice.tsx';
import { Confirm, type Confirmation } from '../../lib/confirm.tsx';
import { overview, unlinkPeer, ROUTE_PREFIX, type Overview, type Peer } from './api.ts';
import { LinkServer } from './LinkServer.tsx';
import { ConnectedServers } from './ConnectedServers.tsx';
import { SharedAlbums } from './SharedAlbums.tsx';
import { Settings } from './Settings.tsx';

export const App = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState<Confirmation | null>(null);
  const [unlinking, setUnlinking] = useState('');
  const [notice, announce, dismiss] = useAnnouncer();

  const load = () =>
    overview()
      .then(setData)
      .catch(e => setError((e as Error).message));

  useEffect(() => {
    void load();
  }, []);

  // LIVE, because the person doing the acting may be on the OTHER server: their household redeeming
  // this server's link, inviting somebody, or a reunion finishing on the wire. Without this the page
  // that MINTED the link is the one place that never shows it took.
  useEffect(() => followServerHints(ROUTE_PREFIX, () => void load()), []);

  const refuseAlbum = () =>
    announce({
      kind: 'error',
      text: "You don't have access to that album — it belongs to someone else on this server.",
    });

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
        unlinkPeer(peer.pub)
          .then(r => {
            announce({ kind: 'ok', text: `Unlinked ${r.household}.` });
            return load();
          })
          .catch((e: Error) => announce({ kind: 'error', text: `Could not unlink: ${e.message}` }))
          .finally(() => setUnlinking(''));
      },
    });
  };

  if (error) {
    return (
      <>
        <div class="isa-page-head">
          <h1 class="isa-page-title">🔗 Shared albums</h1>
        </div>
        <Card>Could not load: {error}. You may need to sign in to Immich as an admin.</Card>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <div class="isa-page-head">
          <h1 class="isa-page-title">🔗 Shared albums</h1>
        </div>
        <p class="isa-page-lede">Loading…</p>
      </>
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
      {notice && <Notice key={notice.id} kind={notice.kind} text={notice.text} onDismiss={dismiss} />}
      <LinkServer onLinked={load} onOutcome={announce} />
      <SharedAlbums albums={data.albums} onDenied={refuseAlbum} />
      <ConnectedServers peers={data.peers} onUnlink={unlink} unlinking={unlinking} />
      <Settings />
      <Confirm ask={asking} onClose={() => setAsking(null)} />
    </>
  );
};
