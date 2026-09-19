/** web/ui/pages/root/document.tsx — the root chooser's prerendered document. See ../../../http-router.md. */
import { Document } from '../../lib/Document.tsx';

export const RootDocument = () => (
  <Document page={{ name: 'root', title: '%%HOUSEHOLD%% — shared albums', hasScript: true }}>
    <main>
      <div id="app"></div>
      <noscript>This page needs JavaScript. It only decides which panel to open.</noscript>
    </main>
  </Document>
);
