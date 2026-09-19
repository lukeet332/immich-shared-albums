/** web/ui/pages/panel/document.tsx — the admin panel's prerendered document. See ../../../http-router.md. */
import { Document } from '../../lib/Document.tsx';

export const PanelDocument = () => (
  <Document page={{ name: 'panel', title: '%%HOUSEHOLD%% — shared albums', hasScript: true }}>
    <main>
      <div id="app"></div>
      <noscript>This page needs JavaScript.</noscript>
    </main>
  </Document>
);
