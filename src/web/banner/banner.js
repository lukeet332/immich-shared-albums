/**
 * Join banner — injected into proxied /share/* pages.
 * Self-contained: shadow DOM (no CSS in/out), no dependencies, fails silent.
 * Dismissal is remembered per share-key in localStorage.
 */
(() => {
  try {
    const SHARE_KEY = location.pathname.split('/share/')[1]?.split(/[/?#]/)[0];
    if (!SHARE_KEY) return;
    const DISMISS_KEY = `isa-dismissed-${SHARE_KEY}`;
    if (localStorage.getItem(DISMISS_KEY)) return;

    const host = document.createElement('div');
    host.id = 'immich-shared-albums-banner';
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          position: fixed; z-index: 2147483000;
          right: 20px; bottom: 20px;
          width: 380px; max-width: calc(100vw - 40px);
          box-sizing: border-box;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #ffffff; color: #1f2937;
          border: 1px solid rgba(0,0,0,.08);
          border-radius: 20px;
          box-shadow: 0 12px 40px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
          padding: 18px 18px 16px;
          animation: isa-in .35s cubic-bezier(.21,1.02,.73,1) both;
        }
        @media (max-width: 560px) {
          .card {
            right: 0; bottom: 0; left: 0; width: 100%; max-width: 100%;
            border-radius: 20px 20px 0 0;
            padding-bottom: max(16px, env(safe-area-inset-bottom));
            animation-name: isa-in-sheet;
          }
        }
        @media (prefers-color-scheme: dark) {
          .card { background: #1f2229; color: #e5e7eb; border-color: rgba(255,255,255,.09); }
          .sub { color: #9ca3af !important; }
          input { background: #15171c !important; color: #e5e7eb !important; border-color: rgba(255,255,255,.12) !important; }
          .dismiss { color: #6b7280 !important; }
        }
        @keyframes isa-in { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
        @keyframes isa-in-sheet { from { transform: translateY(100%); } to { transform: none; } }
        @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
        .row { display: flex; align-items: flex-start; gap: 12px; }
        .logo {
          flex: none; width: 38px; height: 38px; border-radius: 11px;
          display: grid; place-items: center;
          background: linear-gradient(135deg, #4250af, #7c3aed);
        }
        .logo svg { width: 22px; height: 22px; }
        h2 { margin: 1px 0 3px; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
        .sub { margin: 0; font-size: 12.5px; line-height: 1.45; color: #6b7280; }
        form { display: flex; gap: 8px; margin-top: 13px; }
        input {
          flex: 1; min-width: 0; box-sizing: border-box;
          font: inherit; font-size: 13.5px;
          padding: 9px 12px; border-radius: 11px;
          border: 1px solid rgba(0,0,0,.14); background: #f9fafb; color: inherit;
          outline: none; transition: border-color .15s, box-shadow .15s;
        }
        input:focus { border-color: #4250af; box-shadow: 0 0 0 3px rgba(66,80,175,.18); }
        button.join {
          flex: none; font: inherit; font-size: 13.5px; font-weight: 600;
          padding: 9px 16px; border: 0; border-radius: 11px; cursor: pointer;
          background: #4250af; color: #fff; transition: filter .15s, transform .05s;
        }
        button.join:hover { filter: brightness(1.1); }
        button.join:active { transform: scale(.97); }
        .dismiss {
          position: absolute; top: 10px; right: 12px;
          border: 0; background: none; cursor: pointer;
          font-size: 18px; line-height: 1; color: #9ca3af; padding: 4px;
        }
        .hint { margin: 9px 0 0; font-size: 11.5px; color: #9ca3af; }
        .hint a { color: inherit; }
        .card { position: fixed; } /* re-assert after :host reset */
      </style>
      <div class="card" role="dialog" aria-label="Join this album with your own Immich server">
        <button class="dismiss" aria-label="Dismiss">&times;</button>
        <div class="row">
          <div class="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>
            </svg>
          </div>
          <div>
            <h2>Have your own Immich?</h2>
            <p class="sub">Join this album with your household — it appears in your family's app, and photos stay on their owners' servers.</p>
          </div>
        </div>
        <form>
          <input type="text" inputmode="url" autocomplete="off" spellcheck="false"
                 placeholder="your-server.example.com" aria-label="Your server address">
          <button class="join" type="submit">Join</button>
        </form>
        <p class="hint">Nothing to install for viewing — this is only for households running their own server. <a href="/sidecar/about" target="_blank" rel="noopener">What's this?</a></p>
      </div>
    `;

    root.querySelector('.dismiss').addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, '1');
      host.remove();
    });

    root.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      let raw = root.querySelector('input').value.trim();
      if (!raw) return;
      const scheme = raw.startsWith('http://') ? 'http' : 'https';
      const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      // Invite payload rides the fragment: never appears in any server's logs.
      const payload = encodeURIComponent(JSON.stringify({ v: 1, host: location.host, scheme: location.protocol.replace(':',''), key: SHARE_KEY }));
      location.href = `${scheme}://${domain}/sidecar/accept#${payload}`;
    });

    document.body.appendChild(host);
  } catch (_) { /* fail open: share page must never break because of us */ }
})();
