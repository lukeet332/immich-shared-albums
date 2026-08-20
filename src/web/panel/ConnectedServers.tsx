/** web/panel/ConnectedServers.tsx — linked servers, and unlinking them. See ../http-router.md. */
import { useState } from 'preact/hooks';
import { styles } from './theme.ts';
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
      const result = await unlinkPeer(peer.pub);
      setNote(`Unlinked ${result.household}.`);
      onChange();
    } catch (e) {
      setNote(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <div style={styles.card}>
      <b style={{ fontSize: 14 }}>Connected servers</b>
      <p style={styles.muted}>
        Their people appear in Immich's own “share album” picker. Unlinking removes them and everything they
        shared here.
      </p>
      {peers.length === 0 && <p style={styles.muted}>None yet — use “Link a server” above.</p>}
      {peers.map(p => (
        <div key={p.pub} style={{ ...styles.item, ...styles.row }}>
          <span>
            {p.name}
            <div style={styles.sub}>
              {p.url}
              {p.version ? ` · v${p.version}` : ''}
            </div>
          </span>
          <span style={{ textAlign: 'right' }}>
            <div style={styles.sub}>
              {plural(p.people, 'person', 'people')} · {p.sharedToThem} out · {p.sharedToUs} in
            </div>
            <button style={styles.danger} onClick={() => unlink(p)}>
              Unlink
            </button>
          </span>
        </div>
      ))}
      <div style={styles.note}>{note}</div>
    </div>
  );
};
