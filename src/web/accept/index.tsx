/** web/accept/index.tsx — mounts the joining page. See ../http-router.md. */
import { render } from 'preact';
import { Accept } from './Accept.tsx';

const root = document.getElementById('app');
if (root) render(<Accept household={root.dataset.household ?? 'this server'} />, root);
