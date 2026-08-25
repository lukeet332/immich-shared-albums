/** web/ui/pages/panel/Settings.tsx — the panel-managed settings; currently only shared-link joining. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { getSettings, saveSettings } from './api.ts';

const TTL_CHOICES = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 6 * 60, label: '6 hours' },
  { minutes: 24 * 60, label: '24 hours' },
];

export const Settings = () => {
  const [shareLinkJoin, setShareLinkJoin] = useState<boolean | null>(null);
  const [pairingTtl, setPairingTtl] = useState(15);

  useEffect(() => {
    getSettings()
      .then(v => {
        setShareLinkJoin(v.shareLinkJoin);
        setPairingTtl(v.pairingTtlMinutes || 15);
      })
      .catch(() => setShareLinkJoin(true));
  }, []);

  if (shareLinkJoin === null) return null;
  const toggle = async () => {
    const next = !shareLinkJoin;
    setShareLinkJoin(next);
    await saveSettings({ shareLinkJoin: next, pairingTtlMinutes: pairingTtl }).catch(() =>
      setShareLinkJoin(!next)
    );
  };
  const changeTtl = async (event: Event) => {
    const next = Number((event.target as HTMLSelectElement).value);
    const before = pairingTtl;
    setPairingTtl(next);
    await saveSettings({ shareLinkJoin, pairingTtlMinutes: next }).catch(() => setPairingTtl(before));
  };
  return (
    <div style={s.card}>
      <b style={{ fontSize: 14 }}>Settings</b>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
        <input type="checkbox" checked={shareLinkJoin} onChange={toggle} />
        Allow other Immich users to join albums via shared links
      </label>
      <p style={{ ...s.muted, marginTop: 8, fontSize: 12.5 }}>
        On, share pages carry the join card and this server accepts joins. Off, visitors get Immich's share
        page exactly as if this addon were not installed, and join attempts are refused. Linked servers and
        pairing are unaffected.
      </p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, marginTop: 10 }}>
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
