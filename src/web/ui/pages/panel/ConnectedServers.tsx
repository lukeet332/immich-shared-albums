/** web/ui/pages/panel/ConnectedServers.tsx — the linked-servers list, which is where a link is cut. See ../../../http-router.md. */
import { s } from '../../lib/theme.ts';
import type { Peer } from './api.ts';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const ConnectedServers = ({
  peers,
  onUnlink,
  unlinking,
  note,
}: {
  peers: Peer[];
  onUnlink: (peer: Peer) => void;
  /** The `pub` being unlinked right now, so its button cannot submit the same peer twice. */
  unlinking: string;
  note: string;
}) => (
  <div style={s.card}>
    <h2 style={s.cardHeading}>Connected servers</h2>
    <p style={s.muted}>Their people appear in Immich's share picker.</p>
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
          <button
            style={{ ...s.buttonQuiet, ...s.buttonDangerTonal }}
            aria-label={`Unlink ${p.name}`}
            disabled={unlinking === p.pub}
            onClick={() => onUnlink(p)}
          >
            {unlinking === p.pub ? 'Unlinking…' : 'Unlink'}
          </button>
        </span>
      </div>
    ))}
    <div style={s.note}>{note}</div>
  </div>
);
