/** web/ui/pages/panel/Settings.tsx — the panel-managed settings; currently only the share-page join card. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { s } from '../../lib/theme.ts';
import { getSettings, saveSettings } from './api.ts';

export const Settings = () => {
  const [shareShell, setShareShell] = useState<boolean | null>(null);

  useEffect(() => {
    getSettings()
      .then(v => setShareShell(v.shareShell))
      .catch(() => setShareShell(true));
  }, []);

  if (shareShell === null) return null;
  const toggle = async () => {
    const next = !shareShell;
    setShareShell(next);
    await saveSettings({ shareShell: next }).catch(() => setShareShell(!next));
  };
  return (
    <div style={s.card}>
      <b style={{ fontSize: 14 }}>Settings</b>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
        <input type="checkbox" checked={shareShell} onChange={toggle} />
        Show the "join with your own server" card on shared-link pages
      </label>
      <p style={{ ...s.muted, marginTop: 8, fontSize: 12.5 }}>
        Off means visitors get Immich's share page exactly as if this addon were not installed.
      </p>
    </div>
  );
};
