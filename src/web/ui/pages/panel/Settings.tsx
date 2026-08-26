/** web/ui/pages/panel/Settings.tsx — the panel-managed settings: shared-link joining, pairing-link
 *  TTL, and storing shared assets locally. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { getSettings, saveSettings, type Settings as S } from './api.ts';

const TTL_CHOICES = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 6 * 60, label: '6 hours' },
  { minutes: 24 * 60, label: '24 hours' },
];

export const Settings = () => {
  const [shareLinkJoin, setShareLinkJoin] = useState<boolean | null>(null);
  const [pairingTtl, setPairingTtl] = useState(15);
  const [storeLocal, setStoreLocal] = useState(false);

  const load = () =>
    getSettings().then(v => {
      setShareLinkJoin(v.shareLinkJoin);
      setPairingTtl(v.pairingTtlMinutes || 15);
      setStoreLocal(v.storeSharedAssetsLocally);
    });
  useEffect(() => {
    load().catch(() => setShareLinkJoin(true));
  }, []);

  if (shareLinkJoin === null) return null;

  // Every save sends the WHOLE object — the server replaces each field, so a partial save would reset
  // the ones left out. On failure, re-read the server's truth rather than guess.
  const persist = (next: S) => saveSettings(next).catch(() => load());
  const base = (): S => ({
    shareLinkJoin: shareLinkJoin as boolean,
    pairingTtlMinutes: pairingTtl,
    storeSharedAssetsLocally: storeLocal,
  });
  const toggleJoin = () => {
    const next = !shareLinkJoin;
    setShareLinkJoin(next);
    void persist({ ...base(), shareLinkJoin: next });
  };
  const changeTtl = (event: Event) => {
    const next = Number((event.target as HTMLSelectElement).value);
    setPairingTtl(next);
    void persist({ ...base(), pairingTtlMinutes: next });
  };
  const toggleStore = () => {
    const next = !storeLocal;
    setStoreLocal(next);
    void persist({ ...base(), storeSharedAssetsLocally: next });
  };

  return (
    <div style={s.card}>
      <b style={{ fontSize: 14 }}>Settings</b>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
        <input type="checkbox" checked={shareLinkJoin} onChange={toggleJoin} />
        Allow other Immich users to join albums via shared links
      </label>
      <p style={{ ...s.muted, marginTop: 8, fontSize: 12.5 }}>
        On, share pages carry the join card and this server accepts joins. Off, visitors get Immich's share
        page exactly as if this addon were not installed, and join attempts are refused. Linked servers and
        pairing are unaffected.
      </p>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          fontSize: 14,
          marginTop: 12,
        }}
      >
        <input type="checkbox" checked={storeLocal} onChange={toggleStore} />
        Store shared photos on this server
      </label>
      <p style={{ ...s.muted, marginTop: 8, fontSize: 12.5 }}>
        On, this server keeps a full local copy of photos shared with it, so albums stay complete even if the
        other server goes offline. Off (the default), shared photos are lightweight placeholders that stream
        from the owner on demand. Turning this on uses real disk space, and existing shared photos are copied
        over gradually in the background.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, marginTop: 12 }}>
        Pairing links stay valid for
        <select style={s.input} value={pairingTtl} onChange={changeTtl}>
          {TTL_CHOICES.map(c => (
            <option key={c.minutes} value={c.minutes}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <p style={{ ...s.muted, marginTop: 8, fontSize: 12.5 }}>
        A pairing link is shown exactly once, works once, and cannot be recovered after you close it — if it
        gets lost, just create another. Longer validity only widens how long a lost link would matter.
      </p>
    </div>
  );
};
