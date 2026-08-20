/** web/panel/LinkServer.tsx — minting and redeeming a pairing link. See ../../p2p/wire-protocol.md. */
import { useState } from 'preact/hooks';
import { styles } from './theme.ts';
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
    <div style={styles.card}>
      <b style={{ fontSize: 14 }}>Link a server</b>
      <p style={styles.muted}>
        Send your link to the other server's admin, who pastes it into their own panel. It works once, expires
        in 15 minutes, and shares no photos on its own.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={styles.button} onClick={createLink}>
          Create a link
        </button>
        <button style={styles.button} onClick={() => setShowPasteBox(true)}>
          I have a link
        </button>
      </div>

      {link && (
        <div style={{ marginTop: 10 }}>
          <p style={styles.muted}>Send this to them — it works once, and expires in {minutesLeft} minutes.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="pairlink" style={styles.input} readOnly value={link} />
            <button style={styles.button} onClick={copyToClipboard}>
              {copyLabel}
            </button>
          </div>
        </div>
      )}

      {showPasteBox && (
        <form style={{ display: 'flex', gap: 8, marginTop: 10 }} onSubmit={redeemTheirLink}>
          <input
            style={styles.input}
            placeholder="Paste the link they sent you"
            value={theirLink}
            onInput={event => setTheirLink((event.target as HTMLInputElement).value)}
          />
          <button style={styles.button}>Link</button>
        </form>
      )}

      <div style={styles.note}>{note}</div>
    </div>
  );
};
