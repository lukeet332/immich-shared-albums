/** web/ui/pages/share/Share.tsx — the join card floating over the framed native share page. See ../../../http-router.md. */
import { useState } from 'preact/hooks';

// #immich-shared-albums-banner .card/input/button.join/.err are a TEST CONTRACT — the browser
// lane drives this flow through them. Keep them.
const REMEMBERED_SERVER = 'isa-my-server';
const HEALTH_TIMEOUT_MS = 5000;

const shareKeyFromPath = () => location.pathname.split('/share/')[1]?.split(/[/?#]/)[0] ?? '';

const continueToNativePage = () => location.assign(`${location.pathname}?native=1`);

// Browsers forbid an https page fetching an http target (mixed content), so that combination
// cannot be probed — the join proceeds blind and the accept page reports any failure.
const canProbe = (scheme: string) => !(location.protocol === 'https:' && scheme === 'http');

const addonAnswersAt = async (scheme: string, domain: string) => {
  try {
    const r = await fetch(`${scheme}://${domain}/immich-shared-albums/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
};

export const Share = () => {
  const [address, setAddress] = useState(localStorage.getItem(REMEMBERED_SERVER) ?? '');
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  const join = async (e: Event) => {
    e.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    // Mobile keyboards auto-capitalise ("Http://") — parse case-insensitively; no scheme
    // typed means it is discovered with the health probe.
    let scheme = /^https:\/\//i.test(raw) ? 'https' : /^http:\/\//i.test(raw) ? 'http' : null;
    const domain = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    setError('');
    setProbing(true);
    let reachable = false;
    if (scheme) {
      reachable = canProbe(scheme) ? await addonAnswersAt(scheme, domain) : true;
    } else if (await addonAnswersAt('https', domain)) {
      scheme = 'https';
      reachable = true;
    } else if (canProbe('http') && (await addonAnswersAt('http', domain))) {
      scheme = 'http';
      reachable = true;
    } else {
      scheme = 'https';
      reachable = !canProbe('http') && location.protocol !== 'https:';
    }
    setProbing(false);
    if (!reachable) {
      setError(
        `Couldn't find the shared-albums addon at ${domain} — use the address your Immich is served on ` +
          `(with the sidecar routes). Direct setups without a reverse proxy need the sidecar port, not the Immich one.`
      );
      return;
    }
    localStorage.setItem(REMEMBERED_SERVER, raw);
    // The invite rides the fragment so it never appears in any server's logs.
    const endpoint = document.getElementById('immich-shared-albums-banner')?.dataset.originEndpoint ?? '';
    const invite = encodeURIComponent(JSON.stringify({ v: 2, e: endpoint, key: shareKeyFromPath() }));
    location.href = `${scheme}://${domain}/immich-shared-albums/accept#${invite}`;
  };

  const shareKey = shareKeyFromPath();
  return (
    <>
      <iframe class="native-album" src={`/share/${shareKey}?native=1`} title="Shared album" />
      {!dismissed && (
        <div class="card" role="dialog" aria-label="Join this album with your own Immich server">
          <button
            class="dismiss"
            aria-label="Continue to the album"
            onClick={() => {
              setDismissed(true);
              continueToNativePage();
            }}
          >
            &times;
          </button>
          <div class="row">
            <div class="logo" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
              </svg>
            </div>
            <div>
              <h2>Join shared album with your server?</h2>
              <p class="sub">
                Have an Immich server of your own with the shared-albums addon?
                <br />
                If so pop your server address down below to begin sharing photos across servers!
              </p>
            </div>
          </div>
          <form onSubmit={join}>
            <input
              type="text"
              inputMode="url"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              placeholder="your-server.example.com"
              aria-label="Your server address"
              value={address}
              onInput={e => setAddress((e.target as HTMLInputElement).value)}
            />
            <button class="join" type="submit" disabled={probing}>
              {probing ? 'Checking…' : 'Join'}
            </button>
          </form>
          {error && <p class="err">{error}</p>}
          <p class="hint">
            Type your server address once — it's remembered for next time. Nothing to install for viewing.
            <br />
            Want this for your own server?{' '}
            <a href="https://github.com/lukeet332/immich-shared-albums" target="_blank" rel="noopener">
              github.com/lukeet332/immich-shared-albums
            </a>
          </p>
        </div>
      )}
    </>
  );
};
