/** web/ui/pages/me/document.tsx — the per-user panel's prerendered document. See ../../../http-router.md. */
import { Document } from '../../lib/Document.tsx';

export const MeDocument = () => (
  <Document page={{ name: 'me', title: '%%HOUSEHOLD%% — your shared albums', hasScript: true }}>
    <main>
      <div id="app"></div>
      <noscript>
        This page needs JavaScript. It talks to this server's API to show the albums you share with linked
        servers.
      </noscript>
    </main>
  </Document>
);
