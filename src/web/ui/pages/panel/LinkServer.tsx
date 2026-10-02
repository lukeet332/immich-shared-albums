/** web/ui/pages/panel/LinkServer.tsx — linking two servers: mint a pairing link, or paste one from the other admin. See ../../../http-router.md. */
import { useState } from 'preact/hooks';
import { Button } from '../../lib/Button.tsx';
import { Card } from '../../lib/Card.tsx';
import { mintLink, redeemLink } from './api.ts';

export const LinkServer = ({ onLinked }: { onLinked: () => void }) => {
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [theirLink, setTheirLink] = useState('');
  const [note, setNote] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy');

  const createLink = async () => {
    setNote('Creating…');
    try {
      const minted = await mintLink();
      setLink(minted.link);
      setExpiresAt(minted.expiresAt);
      setNote('');
    } catch (err) {
      setNote(`Error: ${(err as Error).message}`);
    }
  };

  const copyToClipboard = async () => {
    // navigator.clipboard needs a secure context, so it is absent on a plain-HTTP LAN panel.
    // Falling back to selecting the text keeps the button from looking broken for exactly the
    // people running the simplest setups.
    try {
      await navigator.clipboard.writeText(link!);
      setCopyLabel('Copied');
    } catch {
      (document.getElementById('pairlink') as HTMLInputElement | null)?.select();
      setCopyLabel('Press Ctrl/Cmd+C');
    }
  };

  const redeemTheirLink = async (event: Event) => {
    event.preventDefault();
    setNote('Linking…');
    try {
      const linked = await redeemLink(theirLink);
      setNote(`Linked with ${linked.linked} — their people can now be invited to albums.`);
      setTheirLink('');
      onLinked();
    } catch (err) {
      setNote(`Error: ${(err as Error).message}`);
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
            <p class="isa-note">
              Send it now: one use, {minutesLeft} minute{minutesLeft === 1 ? '' : 's'} left, and never shown
              again.
            </p>
            <div class="isa-actions">
              <input id="pairlink" class="isa-field" readOnly value={link} />
              <Button onClick={copyToClipboard}>{copyLabel}</Button>
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

        <div class="isa-note">{note}</div>
      </Card>
    </section>
  );
};
