/** web/ui/pages/root/index.tsx — mounts the root chooser. See ../../../http-router.md. */
import { render } from 'preact';
import './root.css';
import { App } from './App.tsx';

const root = document.getElementById('app');
if (root) render(<App />, root);
