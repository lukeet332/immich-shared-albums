/** web/ui/pages/panel/Settings.tsx — the panel-managed settings; currently only shared-link joining. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { getSettings, saveSettings } from './api.ts';

export const Settings = () => {
  const [shareLinkJoin, setShareLinkJoin] = useState<boolean | null>(null);

  useEffect(() => {
    getSettings()
      .then(v => setShareLinkJoin(v.shareLinkJoin))
      .catch(() => setShareLinkJoin(true));
  }, []);

  if (shareLinkJoin === null) return null;
  const toggle = async () => {
    const next = !shareLinkJoin;
    setShareLinkJoin(next);
    await saveSettings({ shareLinkJoin: next }).catch(() => setShareLinkJoin(!next));
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
    </div>
  );
};
