/** web/panel/index.tsx — mounts the admin panel. See ../http-router.md. */
import { render } from 'preact';
import { App } from './App.tsx';

const root = document.getElementById('app');
if (root) render(<App />, root);
