/** web/ui/pages/share/document.tsx — the share page's prerendered document: og tags for crawlers, a mount for the app. See ../../../http-router.md. */
import { Document } from '../../lib/Document.tsx';

export const ShareDocument = () => (
  <Document
    page={{
      name: 'share',
      title: '%%ALBUM%%',
      meta: { 'og:title': '%%ALBUM%%', 'og:type': 'website', 'og:image': '%%COVER%%' },
      hasScript: true,
      matchImmichViewport: true,
    }}
  >
    <div id="share-app"></div>
  </Document>
);
