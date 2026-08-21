/** web/ui/pages/panel/SharedAlbums.tsx — the albums currently shared in either direction. See ../../../http-router.md. */
import { s } from '../../lib/theme.ts';
import type { Album } from './api.ts';

export const SharedAlbums = ({ albums }: { albums: Album[] }) => (
  <div style={s.card}>
    <b style={{ fontSize: 14 }}>Shared albums</b>
    {albums.length === 0 && <p style={s.muted}>None yet.</p>}
    {albums.map(a => (
      <div key={`${a.name}:${a.peer}:${a.role}`} style={{ ...s.item, ...s.row }}>
        <span>{a.name}</span>
        <span style={s.sub}>
          {a.role === 'owner' ? 'shared out' : 'shared with us'} · {a.peer}
          {a.via === 'invite' ? ' · invited' : ''}
        </span>
      </div>
    ))}
  </div>
);
