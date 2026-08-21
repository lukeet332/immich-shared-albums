/** web/ui/pages/panel/LinkServer.tsx — linking two servers: mint a pairing link, or paste one from the other admin. See ../../../http-router.md. */
import { useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
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
    <div style={s.card}>
      <b style={{ fontSize: 14 }}>Link a server</b>
      <p style={s.muted}>
        Send your link to the other server's admin, who pastes it into their own panel. It works once, expires
        in 15 minutes, and shares no photos on its own.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={s.button} onClick={createLink}>
          Create a link
        </button>
        <button style={s.button} onClick={() => setShowPasteBox(true)}>
          I have a link
        </button>
      </div>

      {link && (
        <div style={{ marginTop: 10 }}>
          <p style={s.muted}>Send this to them — it works once, and expires in {minutesLeft} minutes.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="pairlink" style={s.input} readOnly value={link} />
            <button style={s.button} onClick={copyToClipboard}>
              {copyLabel}
            </button>
          </div>
        </div>
      )}

      {showPasteBox && (
        <form style={{ display: 'flex', gap: 8, marginTop: 10 }} onSubmit={redeemTheirLink}>
          <input
            style={s.input}
            placeholder="Paste the link they sent you"
            value={theirLink}
            onInput={event => setTheirLink((event.target as HTMLInputElement).value)}
          />
          <button style={s.button}>Link</button>
        </form>
      )}

      <div style={s.note}>{note}</div>
    </div>
  );
};
