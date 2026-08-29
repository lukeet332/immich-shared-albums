/** web/ui/pages/me/index.tsx — mounts the per-user panel. See ../../../http-router.md. */
import { render } from 'preact';
import './me.css';
import { App } from './App.tsx';

const root = document.getElementById('app');
if (root) render(<App />, root);
