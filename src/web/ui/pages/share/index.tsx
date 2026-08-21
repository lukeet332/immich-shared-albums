/** web/ui/pages/share/index.tsx — mounts the framed album and the join card. See ../../../http-router.md. */
import './share.css';
import { render } from 'preact';
import { Share } from './Share.tsx';

const root = document.getElementById('share-app');
if (root) {
  root.id = 'immich-shared-albums-banner';
  render(<Share />, root);
}
