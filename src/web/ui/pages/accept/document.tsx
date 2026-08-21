/** web/ui/pages/accept/document.tsx — the joining page's prerendered document. See ../../../http-router.md. */
import { Document } from '../../lib/Document.tsx';

export const AcceptDocument = () => (
  <Document page={{ name: 'accept', title: 'Join shared album — %%HOUSEHOLD%%', hasScript: true }}>
    <div class="card">
      <div class="logo">🔗</div>
      <div id="app" data-household="%%HOUSEHOLD%%"></div>
      <noscript>Joining needs JavaScript — it signs you in to your own server and redeems the link.</noscript>
    </div>
  </Document>
);
