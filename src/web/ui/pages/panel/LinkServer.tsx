/** web/ui/pages/panel/LinkServer.tsx — linking two servers: mint a pairing link, or paste one from the other admin. See ../../../http-router.md. */
import { useState } from 'preact/hooks';
import { Button } from '../../lib/Button.tsx';
import { Card } from '../../lib/Card.tsx';
import { mintLink, redeemLink } from './api.ts';
import type { Outcome } from './App.tsx';

export const LinkServer = ({
  onLinked,
  onOutcome,
}: {
  onLinked: () => void;
  /** Where an action's outcome goes: the snackbar the panel already owns, not a line in this card. */
  onOutcome: (outcome: Outcome) => void;
}) => {
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [theirLink, setTheirLink] = useState('');
  const [copied, setCopied] = useState(false);

  const createLink = async () => {
    try {
      const minted = await mintLink();
      setLink(minted.link);
      setExpiresAt(minted.expiresAt);
      onOutcome({ kind: 'ok', text: 'Pairing link created — it is shown once.' });
    } catch (err) {
      onOutcome({ kind: 'error', text: `Could not create a link: ${(err as Error).message}` });
    }
  };

  const copyToClipboard = async () => {
    // navigator.clipboard needs a secure context, so it is absent on a plain-HTTP LAN panel.
    // Falling back to selecting the text keeps the button from looking broken for exactly the
    // people running the simplest setups.
    try {
      await navigator.clipboard.writeText(link!);
      setCopied(true);
      onOutcome({ kind: 'ok', text: 'Link copied to your clipboard.' });
    } catch {
      (document.getElementById('pairlink') as HTMLInputElement | null)?.select();
      onOutcome({ kind: 'error', text: 'Clipboard is blocked here — the link is selected, copy it.' });
    }
  };

  const redeemTheirLink = async (event: Event) => {
    event.preventDefault();
    try {
      const linked = await redeemLink(theirLink);
      onOutcome({
        kind: 'ok',
        text: `Linked with ${linked.linked} — their people can now be invited to albums.`,
      });
      setTheirLink('');
      onLinked();
    } catch (err) {
      onOutcome({ kind: 'error', text: `Could not link: ${(err as Error).message}` });
    }
  };

  const minutesLeft = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));

  return (
    <section class="isa-section">
      <h2 class="isa-section-title">Link a server</h2>
      <Card lede="One use, and it shares no photos.">
        <div class="isa-actions">
          <Button onClick={createLink}>Create a link</Button>
          <Button fill="outlined" onClick={() => setShowPasteBox(true)}>
            I have a link
          </Button>
        </div>

        {link && (
          <div class="isa-stack">
            <p class="isa-setting-description">
              Send it now: one use, {minutesLeft} minute{minutesLeft === 1 ? '' : 's'} left, and never shown
              again.
            </p>
            <div class="isa-actions">
              <input id="pairlink" class="isa-field" readOnly value={link} />
              <Button onClick={copyToClipboard}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </div>
        )}

        {showPasteBox && (
          <form class="isa-stack" onSubmit={redeemTheirLink}>
            <input
              class="isa-field"
              placeholder="Paste the link they sent you"
              value={theirLink}
              onInput={event => setTheirLink((event.target as HTMLInputElement).value)}
            />
            <Button type="submit">Link servers</Button>
          </form>
        )}
      </Card>
    </section>
  );
};
