/** web/panel/SharedAlbums.tsx — albums shared in and out. See ../http-router.md. */
import { styles } from './theme.ts';
import type { Album } from './api.ts';

export const SharedAlbums = ({ albums }: { albums: Album[] }) => (
  <div style={styles.card}>
    <b style={{ fontSize: 14 }}>Shared albums</b>
    {albums.length === 0 && <p style={styles.muted}>None yet.</p>}
    {albums.map(a => (
      <div key={`${a.name}:${a.peer}:${a.role}`} style={{ ...styles.item, ...styles.row }}>
        <span>{a.name}</span>
        <span style={styles.sub}>
          {a.role === 'owner' ? 'shared out' : 'shared with us'} · {a.peer}
          {a.via === 'invite' ? ' · invited' : ''}
        </span>
      </div>
    ))}
  </div>
);
