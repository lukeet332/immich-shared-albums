/** web/ui/pages/panel/index.tsx — mounts the panel app. See ../../../http-router.md. */
import { render } from 'preact';
import './panel.css';
import { App } from './App.tsx';

const root = document.getElementById('app');
if (root) render(<App />, root);
