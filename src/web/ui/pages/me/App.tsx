/** web/ui/pages/me/App.tsx — the per-user panel: your shared albums, the possible reunions and what
 *  can be done about each one, and the albums you have reunited. See ../../../http-router.md. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { AlbumLink } from '../../lib/AlbumLink.tsx';
import { useAnnouncer } from '../../lib/announce.ts';
import { Button } from '../../lib/Button.tsx';
import { Card } from '../../lib/Card.tsx';
import { Notice } from '../../lib/Notice.tsx';
import { Setting } from '../../lib/Setting.tsx';
import { Switch } from '../../lib/Switch.tsx';
import { Confirm, type Confirmation } from '../../lib/confirm.tsx';
import {
  ROUTE_PREFIX,
  invite,
  myAlbums,
  myMatches,
  myPreferences,
  reunite,
  savePreferences,
  unreunite,
  type ActionableMatch,
  type MyAlbum,
} from './api.ts';

/** One row's identity: two candidates that agree on all of this are the same row (`asOneRow` on the
 *  server collapses them), so it is also what Preact needs to keep them apart. */
const rowKey = (m: ActionableMatch) =>
  `${m.peer}:${m.mine.name}:${m.theirs.ownerName}:${m.theirs.assetCount}:${m.theirs.startDate ?? ''}:${m.theirs.endDate ?? ''}`;

export const App = () => {
  const [albums, setAlbums] = useState<MyAlbum[] | null>(null);
  const [household, setHousehold] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [matches, setMatches] = useState<ActionableMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Default ON. The trail exists to be read, and hiding it is a choice this person makes for
  // themselves — it never changes what anyone else sees.
  const [auditVisible, setAuditVisible] = useState(true);
  const [reuniting, setReuniting] = useState('');
  const [inviting, setInviting] = useState('');
  const [detaching, setDetaching] = useState('');
  const [notice, announce, dismiss] = useAnnouncer();
  const [asking, setAsking] = useState<Confirmation | null>(null);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    myAlbums()
      .then(r => {
        setAlbums(r.albums);
        setHousehold(r.household);
        setIsAdmin(r.isAdmin);
      })
      .catch(e => setError(e.message));
    // Its own request: a linked server being offline must not stop the albums above rendering.
    myMatches()
      .then(r => setMatches(r.matches))
      .catch(() => setMatches([]));
    myPreferences()
      .then(r => setAuditVisible(r.auditVisibleInComments))
      .catch(() => {}); // a preference we cannot read leaves the default, which is SHOW
  }, []);

  // LIVE, because the other household acts on their own server: an invitation they send, a pair
  // their panel publishes, a reunion finishing on the wire. The event is a HINT and carries nothing
  // — every list below is re-read as this caller, so a hint can never show them anything they could
  // not fetch themselves. EventSource reconnects on its own, and a sidecar that predates the route
  // simply answers 404 and the panel behaves exactly as it did before.
  useEffect(() => {
    const events = new EventSource(`${ROUTE_PREFIX}/events`);
    events.onmessage = () => void refreshBoth();
    return () => events.close();
  }, []);

  /** One reload for both lists: they describe one state, and a mutation changes both.
   *
   *  Settled INDEPENDENTLY. `Promise.all` rejects the pair if either read fails, which would report a
   *  mutation that succeeded as a failure and leave both lists showing the state before it. */
  const refreshBoth = async () => {
    // GENERATION-GUARDED: the live channel can fire another refresh while this one is in flight, and
    // a slower earlier answer landing last would put the panel back to a state it has moved past.
    const generation = ++refreshGeneration.current;
    const [freshMatches, freshAlbums] = await Promise.allSettled([myMatches(), myAlbums()]);
    if (generation !== refreshGeneration.current) return;
    if (freshMatches.status === 'fulfilled') setMatches(freshMatches.value.matches);
    if (freshAlbums.status === 'fulfilled') setAlbums(freshAlbums.value.albums);
  };

  /** Optimistic, then corrected by the server's answer: the switch must not hang on a round trip,
   *  and a refusal has to put it back rather than leave the panel claiming a setting it did not save. */
  const onToggleAudit = async (next: boolean) => {
    setAuditVisible(next);
    dismiss();
    try {
      const saved = await savePreferences({ auditVisibleInComments: next });
      setAuditVisible(saved.auditVisibleInComments);
    } catch (e) {
      setAuditVisible(!next);
      announce({ kind: 'error', text: `Could not change that setting: ${(e as Error).message}` });
    }
  };

  const onReunite = async (m: ActionableMatch) => {
    if (!m.mappingId) return; // no share to reunite: this pairing has never been shared
    setReuniting(rowKey(m));
    dismiss();
    try {
      const r = await reunite(m.mappingId, m.mine.name);
      announce({
        kind: 'ok',
        text: `Reunited into "${r.album}" — ${r.seeded} photo(s) were already there.`,
      });
      // BOTH lists: a reunion moves a share out of the matches list and into the reunified one, so
      // refreshing only the matches leaves the albums below describing a state that no longer holds.
      await refreshBoth();
    } catch (e) {
      announce({ kind: 'error', text: `Could not reunite: ${(e as Error).message}` });
    } finally {
      setReuniting('');
    }
  };

  /** Share MY album with them, which is what a reunion starts from. The server does the membership;
   *  the other person then sees this pairing as an invitation they can accept. */
  const onInvite = async (m: ActionableMatch) => {
    setInviting(rowKey(m));
    dismiss();
    try {
      const r = await invite(m.peer, m.mine.name, m.theirs.ownerUserId);
      announce({
        kind: 'ok',
        text: `Invited ${r.invited} to reunite “${r.album}” — it is now in their panel to accept.`,
      });
      await refreshBoth();
    } catch (e) {
      announce({ kind: 'error', text: `Could not invite: ${(e as Error).message}` });
    } finally {
      setInviting('');
    }
  };

  const onUnreunite = async (album: MyAlbum) => {
    setDetaching(album.mappingId);
    dismiss();
    try {
      const r = await unreunite(album.mappingId);
      announce({
        kind: 'ok',
        text: `"${r.left}" is yours again — ${r.purged} shared photo(s) removed from it.`,
      });
      await refreshBoth(); // same reason, the other way round
    } catch (e) {
      announce({ kind: 'error', text: `Could not un-reunite: ${(e as Error).message}` });
    } finally {
      setDetaching('');
    }
  };

  const reunifiedAlbums = albums?.filter(a => a.reunified) ?? [];

  return (
    // A fragment, not a <main>: document.tsx already provides the page's one <main>, and a second
    // inside it is invalid and announces two landmarks.
    <>
      <div class="isa-page-head">
        <h1 class="isa-page-title">🔗 Shared albums</h1>
        <span class="isa-page-household">· {household || '…'}</span>
      </div>
      <p class="isa-page-lede">
        Only your own Immich account.
        {isAdmin && (
          <>
            {' '}
            <a href={`${ROUTE_PREFIX}/admin`}>Server settings and pairings →</a>
          </>
        )}
      </p>
      {notice && <Notice key={notice.id} kind={notice.kind} text={notice.text} onDismiss={dismiss} />}

      {reunifiedAlbums.length > 0 && (
        <section class="isa-section">
          <h2 class="isa-section-title">Reunified albums</h2>
          <Card>
            <div class="isa-rows">
              {reunifiedAlbums.map(a => (
                <div class="isa-row" key={a.mappingId}>
                  <div class="isa-row-main">
                    <AlbumLink albumId={a.albumId} name={a.name} />
                    <div class="isa-row-sub">
                      {a.adoptedByUs === false ? `reunited by ${a.peer}` : 'yours, reunited'}
                    </div>
                  </div>
                  {a.adoptedByUs === false ? (
                    // They adopted the share this household gave them, so there is no adoption of
                    // ours to undo — an Un-reunite click here would answer 404. Undoing an
                    // invitation is withdrawing the share, which is Immich's own album settings.
                    <div class="isa-row-text">
                      Merged into their album. To undo, remove their access to this album in Immich's sharing
                      settings.
                    </div>
                  ) : (
                    <div class="isa-row-action">
                      <Button
                        disabled={!!detaching}
                        onClick={() =>
                          setAsking({
                            title: 'Un-reunite?',
                            body: 'Your album keeps your photos. Only theirs are removed.',
                            confirm: 'Un-reunite',
                            danger: true,
                            onConfirm: () => onUnreunite(a),
                          })
                        }
                      >
                        {detaching === a.mappingId ? 'Un-reuniting…' : 'Un-reunite'}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}

      {matches.length > 0 && (
        <section class="isa-section">
          <h2 class="isa-section-title">Possible album reunions</h2>
          <p class="isa-section-lede">The same album, half on each server.</p>
          <Card>
            <div class="isa-rows">
              {matches.map(m => (
                <div class="isa-row" key={rowKey(m)}>
                  <div class="isa-row-main">
                    <AlbumLink albumId={m.albumId} name={m.mine.name} />
                    <div class="isa-row-sub">
                      yours: {m.mine.assetCount} {m.mine.assetCount === 1 ? 'photo' : 'photos'} ·{' '}
                      {m.theirs.ownerName} on {m.peerName}: {m.theirs.assetCount}{' '}
                      {m.theirs.assetCount === 1 ? 'photo' : 'photos'}
                      {m.sameDates ? ' · dates line up' : ''}
                    </div>
                  </div>
                  {m.step.kind === 'invite' && (
                    // Nothing shared between the two of you yet. This shares MY album with them, the
                    // same membership Immich's own picker makes — so the reunion can start from here.
                    <div class="isa-row-action">
                      <Button
                        disabled={!!inviting}
                        onClick={() =>
                          setAsking({
                            title: `Invite ${m.theirs.ownerName}?`,
                            body: 'Shares this album with them, so they can accept the reunion.',
                            confirm: 'Invite',
                            onConfirm: () => onInvite(m),
                          })
                        }
                      >
                        {inviting === rowKey(m) ? 'Inviting…' : `Invite ${m.theirs.ownerName}`}
                      </Button>
                    </div>
                  )}
                  {m.step.kind === 'accept' && (
                    <div class="isa-row-action">
                      <Button
                        disabled={!!reuniting}
                        onClick={() =>
                          setAsking({
                            title: 'Accept the invite?',
                            body: 'Merges their photos into your album. You can undo it.',
                            confirm: 'Accept',
                            onConfirm: () => onReunite(m),
                          })
                        }
                      >
                        {reuniting === rowKey(m) ? 'Reuniting…' : 'Accept invite'}
                      </Button>
                    </div>
                  )}
                  {m.step.kind === 'waiting' && (
                    // I shared mine with them; adopting my own album is not an adoption at all, so
                    // there is nothing to click until they accept on their side.
                    <div class="isa-row-text">
                      Invited {m.theirs.ownerName} — waiting for them to accept in their panel.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}

      <section class="isa-section">
        <h2 class="isa-section-title">Your shared albums</h2>
        {error && <Card>Couldn't load your albums: {error}</Card>}
        {!error && albums === null && <Card>Loading…</Card>}
        {albums && albums.length === 0 && (
          <Card>
            <span class="isa-empty">
              No shared albums yet. Share an album with a linked server to see it here.
            </span>
          </Card>
        )}
        {albums && albums.length > 0 && (
          <Card>
            <div class="isa-rows">
              {albums.map(a => (
                <div class="isa-row" key={`${a.peer}:${a.name}`}>
                  <div class="isa-row-main">
                    <AlbumLink albumId={a.albumId} name={a.name} />
                    <div class="isa-row-sub">
                      {/* A reunion adopts the person's OWN album, so the mapping's role says how the
                          share arrived, not whose album this is — "shared with you" for an album you
                          own is the one thing the row must not say. A share the PEER adopted was
                          reunited by them, not by this household. */}
                      {a.reunified
                        ? a.adoptedByUs === false
                          ? 'reunited by them'
                          : 'yours, reunited'
                        : a.role === 'owner'
                          ? 'shared by you'
                          : 'shared with you'}{' '}
                      · with {a.peer}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>

      <section class="isa-section">
        <h2 class="isa-section-title">Album activity</h2>
        <Card>
          <Setting
            label="Display bot comments"
            description="What the addon did is written into the album as comments. Off hides them from you only — everyone else still sees them."
          >
            <Switch id="audit-visible" checked={auditVisible} onChange={next => void onToggleAudit(next)} />
          </Setting>
        </Card>
      </section>

      <Confirm ask={asking} onClose={() => setAsking(null)} />
    </>
  );
};
