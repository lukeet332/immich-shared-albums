/** web/ui/pages/sign-in/document.tsx — the static sign-in prompt human routes answer with. See ../../../http-router.md. */
import { Document } from '../../lib/Document.tsx';

export const SignInDocument = () => (
  <Document page={{ name: 'sign-in', title: 'Sign in — %%HOUSEHOLD%%' }}>
    <div class="card">
      <h1>Sign in to continue</h1>
      <p>You need to be signed in to %%HOUSEHOLD%% to %%WHAT%%.</p>
      <a href="/auth/login">Sign in to Immich</a>
    </div>
  </Document>
);
