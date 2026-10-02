/** web/ui/pages/panel/Settings.tsx — the panel-managed settings: shared-link joining, pairing-link
 *  TTL, and storing shared assets locally. See ../../../http-router.md. */
import { useEffect, useState } from 'preact/hooks';
import { Card } from '../../lib/Card.tsx';
import { Setting } from '../../lib/Setting.tsx';
import { Switch } from '../../lib/Switch.tsx';
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
  const toggleJoin = (next: boolean) => {
    setShareLinkJoin(next);
    void persist({ ...base(), shareLinkJoin: next });
  };
  const changeTtl = (event: Event) => {
    const next = Number((event.target as HTMLSelectElement).value);
    setPairingTtl(next);
    void persist({ ...base(), pairingTtlMinutes: next });
  };
  const toggleStore = (next: boolean) => {
    setStoreLocal(next);
    void persist({ ...base(), storeSharedAssetsLocally: next });
  };

  return (
    <section class="isa-section">
      <h2 class="isa-section-title">Settings</h2>
      <Card>
        <Setting
          label="Allow other Immich users to join albums via shared links"
          description="Off, share pages are Immich's own and joins are refused. Linked servers and pairing are unaffected."
        >
          <Switch id="share-link-join" checked={shareLinkJoin} onChange={toggleJoin} />
        </Setting>
        <Setting
          label="Store shared photos on this server"
          description="Off, they stream from their owner and use no space here. On, they are copied over in the background and use real disk space. Turning this off does not remove copies already made."
        >
          <Switch id="store-locally" checked={storeLocal} onChange={toggleStore} />
        </Setting>
        <Setting label="Pairing links stay valid for" description="Shown once. Create another if it is lost.">
          <select class="isa-field" value={pairingTtl} onChange={changeTtl}>
            {TTL_CHOICES.map(c => (
              <option key={c.minutes} value={c.minutes}>
                {c.label}
              </option>
            ))}
          </select>
        </Setting>
      </Card>
    </section>
  );
};
