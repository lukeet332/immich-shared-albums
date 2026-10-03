/** web/ui/pages/panel/SharedAlbums.tsx — the albums currently shared in either direction. See ../../../http-router.md. */
import { AlbumLink } from '../../lib/AlbumLink.tsx';
import { Card } from '../../lib/Card.tsx';
import type { Album } from './api.ts';

export const SharedAlbums = ({ albums }: { albums: Album[] }) => (
  <section class="isa-section">
    <h2 class="isa-section-title">Shared albums</h2>
    <Card>
      {albums.length === 0 ? (
        <span class="isa-empty">None yet.</span>
      ) : (
        <div class="isa-rows">
          {albums.map(a => (
            <div class="isa-row" key={`${a.name}:${a.peer}:${a.role}`}>
              <div class="isa-row-main">
                <AlbumLink albumId={a.albumId} name={a.name} />
                <div class="isa-row-sub">
                  {a.role === 'owner' ? 'shared out' : 'shared with us'} · {a.peer}
                  {a.via === 'invite' ? ' · invited' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  </section>
);
