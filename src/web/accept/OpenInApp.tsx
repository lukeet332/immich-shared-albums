/** web/accept/OpenInApp.tsx — the deeplink, gated on the album filling. See ../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { albumCount, deepLink } from './api.ts';

const SYNC_WAIT_LIMIT_MS = 90_000;
const SYNC_CHECK_EVERY_MS = 1_500;

export const OpenInApp = ({ albumId, photos }: { albumId: string; photos: number }) => {
  const [photosArrived, setPhotosArrived] = useState(0);
  const [linkEnabled, setLinkEnabled] = useState(photos === 0);

  useEffect(() => {
    if (linkEnabled) return;
    const waitingSince = Date.now();

    const checkTimer = setInterval(async () => {
      const arrived = await albumCount(albumId);
      setPhotosArrived(Math.min(arrived, photos));

      const allArrived = arrived >= photos;
      const waitedTooLong = Date.now() - waitingSince > SYNC_WAIT_LIMIT_MS;
      if (allArrived || waitedTooLong) {
        clearInterval(checkTimer);
        setLinkEnabled(true);
      }
    }, SYNC_CHECK_EVERY_MS);

    return () => clearInterval(checkTimer);
  }, [albumId, photos, linkEnabled]);

  if (!linkEnabled) {
    return (
      <a id="openapp" class="cta" style={{ opacity: 0.45, pointerEvents: 'none' }}>
        <span class="spin" />
        Syncing {photosArrived}/{photos}…
      </a>
    );
  }
  return (
    <a id="openapp" class="cta" href={deepLink(albumId)}>
      Open in Immich app
    </a>
  );
};
