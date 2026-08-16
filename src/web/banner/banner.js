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
          right: 24px; bottom: 24px;
          width: 400px; max-width: calc(100vw - 32px);
          box-sizing: border-box;
          font-family: 'Overpass', 'Inter', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: #ffffff; color: #202124;
          border: 1px solid rgba(0,0,0,.06);
          border-radius: 28px;
          box-shadow: 0 1px 3px rgba(60,64,67,.15), 0 8px 28px rgba(60,64,67,.22);
          padding: 22px 22px 18px;
          animation: isa-in .35s cubic-bezier(.21,1.02,.73,1) both;
        }
        @media (max-width: 560px) {
          .card {
            right: 0; bottom: 0; left: 0; width: auto; max-width: none;
            border-radius: 28px 28px 0 0;
            padding-bottom: max(18px, env(safe-area-inset-bottom));
            animation-name: isa-in-sheet;
          }
        }
        @media (prefers-color-scheme: dark) {
          .card { background: #1b1f26; color: #e8eaed; border-color: rgba(255,255,255,.08); box-shadow: 0 1px 3px rgba(0,0,0,.4), 0 10px 32px rgba(0,0,0,.5); }
          .sub { color: #9aa0a6 !important; }
          input { background: #262b33 !important; color: #e8eaed !important; }
          input::placeholder { color: #7d8590; }
          input:focus { background: #2a3038 !important; }
          .dismiss { color: #9aa0a6 !important; }
          .dismiss:hover { background: rgba(255,255,255,.08) !important; }
          .hint { color: #7d8590 !important; }
          .hint a { color: #a8c7fa !important; }
          button.join { background: #a8c7fa !important; color: #0d1b3d !important; }
        }
        @keyframes isa-in { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
        @keyframes isa-in-sheet { from { transform: translateY(100%); } to { transform: none; } }
        @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
        .row { display: flex; align-items: flex-start; gap: 14px; padding-right: 26px; }
        .logo {
          flex: none; width: 42px; height: 42px; border-radius: 50%;
          display: grid; place-items: center;
          background: linear-gradient(135deg, #4250af, #7c3aed);
          box-shadow: 0 2px 8px rgba(66,80,175,.35);
        }
        .logo svg { width: 22px; height: 22px; }
        h2 { margin: 2px 0 5px; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
        .sub { margin: 0; font-size: 13px; line-height: 1.5; color: #5f6368; }
        form { display: flex; gap: 10px; margin-top: 16px; }
        input {
          flex: 1; min-width: 0; box-sizing: border-box;
          font: inherit; font-size: 14px;
          padding: 11px 18px; border-radius: 999px;
          border: 1px solid transparent; background: #f1f3f4; color: inherit;
          outline: none; transition: background .15s, border-color .15s, box-shadow .15s;
        }
        input:focus { background: #fff; border-color: #4250af; box-shadow: 0 0 0 3px rgba(66,80,175,.15); }
        button.join {
          flex: none; font: inherit; font-size: 14px; font-weight: 600;
          padding: 11px 22px; border: 0; border-radius: 999px; cursor: pointer;
          background: #4250af; color: #fff; transition: filter .15s, box-shadow .15s, transform .05s;
        }
        button.join:hover { filter: brightness(1.08); box-shadow: 0 2px 10px rgba(66,80,175,.4); }
        button.join:active { transform: scale(.97); }
        .dismiss {
          position: absolute; top: 14px; right: 14px;
          width: 32px; height: 32px; box-sizing: border-box;
          border: 0; border-radius: 50%; background: none; cursor: pointer;
          font-size: 18px; line-height: 1; color: #5f6368; padding: 0;
          display: grid; place-items: center; transition: background .15s;
        }
        .dismiss:hover { background: rgba(0,0,0,.06); }
        .hint { margin: 14px 0 0; font-size: 12px; line-height: 1.55; color: #80868b; }
        .hint a { color: #4250af; text-decoration: none; }
        .hint a:hover { text-decoration: underline; }
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
            <h2>Join shared album with your server?</h2>
            <p class="sub">Have an Immich server of your own with the shared-albums addon?<br>If so pop your server address down below to begin sharing photos across servers!</p>
          </div>
        </div>
        <form>
          <input type="text" inputmode="url" autocomplete="off" spellcheck="false"
                 placeholder="your-server.example.com" aria-label="Your server address">
          <button class="join" type="submit">Join</button>
        </form>
        <p class="err" style="display:none;margin:10px 0 0;font-size:12.5px;color:#d93025"></p>
        <p class="hint">Type your server address once — it's remembered for next time. Nothing to install for viewing.<br>Want this for your own server? <a href="https://github.com/lukeet332/immich-shared-albums" target="_blank" rel="noopener">github.com/lukeet332/immich-shared-albums</a></p>
      </div>
    `;

    root.querySelector('.dismiss').addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, '1');
      host.remove();
    });

    const remembered = localStorage.getItem('isa-my-server');
    if (remembered) root.querySelector('input').value = remembered;
    root.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = root.querySelector('input').value.trim();
      if (!raw) return;
      const scheme = raw.startsWith('http://') ? 'http' : 'https';
      const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const btn = root.querySelector('button.join');
      const err = root.querySelector('.err');
      err.style.display = 'none';
      btn.textContent = 'Checking…'; btn.disabled = true;
      // pre-flight: don't strand people on a 404 if the addon isn't at that address.
      // Browsers forbid https pages fetching http targets (mixed content), so an http
      // destination can't be probed from an https share page — redirect blind instead.
      const probeable = !(location.protocol === 'https:' && scheme === 'http');
      let ok = !probeable;
      if (probeable) {
        try {
          const r = await fetch(`${scheme}://${domain}/sidecar/health`, { signal: AbortSignal.timeout(6000) });
          ok = r.ok && (await r.json()).ok === true;
        } catch (_) { /* unreachable or no addon */ }
      }
      btn.textContent = 'Join'; btn.disabled = false;
      if (!ok) {
        err.textContent = `Couldn't find the shared-albums addon at ${domain} — use the address your Immich is served on (with the sidecar routes). Direct setups without a reverse proxy need the sidecar port, not the Immich one.`;
        err.style.display = 'block';
        return;
      }
      localStorage.setItem('isa-my-server', raw);
      // Invite payload rides the fragment: never appears in any server's logs.
      const payload = encodeURIComponent(JSON.stringify({ v: 1, host: location.host, scheme: location.protocol.replace(':',''), key: SHARE_KEY }));
      location.href = `${scheme}://${domain}/sidecar/accept#${payload}`;
    });

    document.body.appendChild(host);
  } catch (_) { /* fail open: share page must never break because of us */ }
})();
