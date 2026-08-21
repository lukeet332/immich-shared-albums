/** web/ui/pages/accept/index.tsx — mounts the joining flow. See ../../../http-router.md. */
import { render } from 'preact';
import './accept.css';
import { Accept } from './Accept.tsx';

const root = document.getElementById('app');
if (root) render(<Accept household={root.dataset.household ?? 'this server'} />, root);
