import { useEffect, useState } from 'preact/hooks';
import { readInvite } from './fragment.ts';
import { join, whoami, type JoinResult, type Me } from './api.ts';
import { OpenInApp } from './OpenInApp.tsx';

/**
 * The element ids below (#who, #go, #out, and #openapp in OpenInApp) are a TEST CONTRACT: the
 * browser lane in demo/e2e/browser-test.mjs drives this page through them. Converting this page
 * to components dropped them for class names, and the browser tests failed while the 141-check
 * API suite stayed green — that lane is the only thing covering this flow end to end. Keep them.
 */

/** How often to re-check whether they have signed in, while this page waits. */
const SIGN_IN_POLL_MS = 2500;

export const Accept = ({ household }: { household: string }) => {
  // Read ONCE. readInvite() has a side effect — it strips the invite out of the query string via
  // history.replaceState so it never lingers in the address bar — so calling it on every render
  // makes the invite vanish on the second one, mid-join.
  const [invite] = useState(readInvite);
  const [signedInUser, setSignedInUser] = useState<Me | null>(null);
  const [joinInProgress, setJoinInProgress] = useState(false);
  const [albumNeedsPassword, setAlbumNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [message, setMessage] = useState('');

  // Wait for a session rather than demanding one up front: people arrive here from someone else's
  // share page, sign in to their own Immich in another tab, and come back to this one.
  useEffect(() => {
    let unmounted = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const captureSignedInUser = async (): Promise<boolean> => {
      const user = await whoami();
      if (!user || unmounted) return false;
      setSignedInUser(user);
      return true;
    };

    const startPollingUntilSignedIn = async () => {
      if (await captureSignedInUser()) return;
      pollTimer = setInterval(async () => {
        if (await captureSignedInUser()) clearInterval(pollTimer);
      }, SIGN_IN_POLL_MS);
    };
    void startPollingUntilSignedIn();

    // The effect's own return value is the only cleanup Preact honours — returning it from inside
    // a .then() was dead code, and left this interval running after the page navigated away.
    return () => {
      unmounted = true;
      clearInterval(pollTimer);
    };
  }, []);

  if (!invite) {
    return (
      <>
        <h1>Invalid or expired invite</h1>
        <p>This link is missing the album details. Ask whoever shared it to send it again.</p>
      </>
    );
  }

  const acceptInvite = async () => {
    if (!signedInUser) return;
    setJoinInProgress(true);
    setMessage('');

    const shareUrl = `${invite.scheme}://${invite.host}/share/${invite.key}`;
    const outcome = await join(shareUrl, signedInUser.id, albumNeedsPassword ? password : undefined);

    // The session went away between page load and click — send them to sign in and back.
    if (outcome.needsAuth) {
      location.href = outcome.signInUrl || '/auth/login';
      return;
    }
    // The same password the album's own share page asks for. The origin verifies it, not us.
    if (outcome.passwordRequired) {
      setAlbumNeedsPassword(true);
      setJoinInProgress(false);
      setMessage('This album is password protected. Enter the same password you would use to view it.');
      return;
    }

    setJoinInProgress(false);
    if (outcome.ok) setJoined(outcome);
    else setMessage(`Error: ${outcome.error ?? 'failed'}`);
  };

  if (joined?.ok) {
    return (
      <>
        <h1>All set</h1>
        <div id="out" class="out">
          Joined “{joined.album}” from {joined.from}.
          {joined.permissions === 'view' &&
            ' View-only album: you can look and comment, but photos you add stay on your server.'}
        </div>
        <OpenInApp albumId={joined.albumId!} photos={joined.photos ?? 0} />
      </>
    );
  }

  return (
    <>
      <h1>Join shared album?</h1>
      <p>
        This will add the album to your account on <b>{household}</b>. Photos stay on their owners' servers.
      </p>
      <div id="who" class="who">
        {signedInUser ? (
          `Joining as ${signedInUser.name} — the album is added only to your account.`
        ) : (
          <>
            <a href="/auth/login">Sign in to your Immich</a> to join — this page will notice once you are
            signed in.
          </>
        )}
      </div>
      {albumNeedsPassword && (
        <input
          class="pw"
          type="password"
          placeholder="Album password"
          autocomplete="current-password"
          value={password}
          onInput={e => setPassword((e.target as HTMLInputElement).value)}
        />
      )}
      <button
        id="go"
        disabled={!signedInUser || joinInProgress}
        class={joinInProgress ? 'busy' : ''}
        onClick={acceptInvite}
      >
        {joinInProgress ? (
          <>
            <span class="spin" />
            Joining — syncing photos…
          </>
        ) : (
          'Accept & join'
        )}
      </button>
      <div id="out" class="out">
        {message}
      </div>
    </>
  );
};
