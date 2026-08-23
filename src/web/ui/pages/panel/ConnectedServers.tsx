/** web/ui/pages/panel/ConnectedServers.tsx — the linked-servers list, with unlink and its confirmation. See ../../../http-router.md. */
import { useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { unlinkPeer, type Peer } from './api.ts';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const ConnectedServers = ({ peers, onChange }: { peers: Peer[]; onChange: () => void }) => {
  const [note, setNote] = useState('');

  const unlink = async (peer: Peer) => {
    if (
      !confirm(
        `Unlink "${peer.name}"?\n\nTheir photos and albums are removed from this server, and ` +
          `albums you shared with them stop syncing. Your own photos are untouched.`
      )
    ) {
      return;
    }
    setNote('Unlinking…');
    try {
      const r = await unlinkPeer(peer.pub);
      setNote(`Unlinked ${r.household}.`);
      onChange();
    } catch (e) {
      setNote(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <div style={s.card}>
      <b style={{ fontSize: 14 }}>Connected servers</b>
      <p style={s.muted}>
        Their people appear in Immich's own “share album” picker. Unlinking removes them and everything they
        shared here.
      </p>
      {peers.length === 0 && <p style={s.muted}>None yet — use “Link a server” above.</p>}
      {peers.map(p => (
        <div key={p.pub} style={{ ...s.item, ...s.row }}>
          <span>
            {p.name}
            <div style={s.sub}>{p.version ? `v${p.version}` : 'linked'}</div>
          </span>
          <span style={{ textAlign: 'right' }}>
            <div style={s.sub}>
              {plural(p.people, 'person', 'people')} · {p.sharedToThem} out · {p.sharedToUs} in
            </div>
            <button style={s.danger} onClick={() => unlink(p)}>
              Unlink
            </button>
          </span>
        </div>
      ))}
      <div style={s.note}>{note}</div>
    </div>
  );
};
