/**
 * p2p/mirror.ts — creating the local mirror of a remote album.
 *
 * Extracted from join.ts because there are now two ways to acquire an album and only one way to
 * mirror it: redeeming a share link (join.ts), and being invited in the origin's own Immich
 * picker (sync/invites.ts). The mirror itself is identical either way — a utility user owns it
 * so it stays out of local timelines, local humans are added with the role the share's
 * permission maps to in Immich's own vocabulary, and the reconciler fills it in behind
 * the answer.
 */
import crypto from 'node:crypto';
import { CFG, log, isUtilityEmail, BOT_PREFIX, UTILITY_EMAIL_DOMAIN } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, store, save, seenAdd } from '../state.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { readAlbumAssetsAs, readCallerAlbums, callAs, type Creds } from '../immich/access.ts';
import { ensureUtilityUser, syncAvatar } from '../immich/contributors.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { canUnifyOwnAlbum, findAdoptableAlbum } from '../sync/adoption.ts';
import { addHouseBotToAlbum } from '../sync/house-bot.ts';
import { deleteProxyAsset } from '../immich/materialise.ts';
import { seedRowsFor } from '../sync/matches.ts';
import { albumTeardown } from '../sync/album-teardown.ts';
import { grantAlbumWriters, grantInvitedHumans, peerContributors } from '../sync/album-grant.ts';
import { auditLine } from '../sync/audit.ts';
import { pullCanonicalComments } from '../sync/comments.ts';

export type MirrorRequest = {
  peer: Peer;
  album: { id: string; name: string };
  permissions: 'view' | 'contribute';
  /** Display name of the album's owner on the origin; falls back to the household name. */
  albumOwnerName?: string;
  /** Origin user id, for syncing that person's avatar onto the local utility user. */
  albumOwnerId?: string;
  /** The origin's own mapping id, when known (link joins carry it; invitations do not). */
  remoteMappingId?: string;
  /** Restrict the mirror to these local users (per-person invitations). Omit to add every
   *  human, which is what a link join does — a link is redeemed BY someone, for the household. */
  forUserIds?: string[];
  /** How this share was acquired. Scopes member-side withdrawal: only invitation-created
   *  mirrors may be torn down when an invitation stops being offered. */
  via?: 'link' | 'invite';
  /** The origin says this album is part of a reunion. Recorded, never inferred: the local mapping
   *  is an ordinary member mirror either way, and only the category distinguishes it. */
  reunified?: boolean;
  /** ADOPT this local album instead of creating a mirror — reunifying, rather than joining. The
   *  caller's own credentials, because only they can read and add a member to an album they own. */
  adopt?: { albumId: string; ownerUserId: string; ownerCreds: Creds };
};

/**
 * Ensure a mirror exists for `album` from `peer`. Idempotent: if one already exists this just
 * makes sure the requested local user is a member, matching the re-join behaviour.
 */
export async function ensureMirror(req: MirrorRequest): Promise<{ mapping: Mapping; created: boolean }> {
  const { peer, album, permissions, forUserIds } = req;
  const ownerName = req.albumOwnerName || peer.name;
  // The album's owner is a person on that peer, keyed by their id on THEIR server — required,
  // so the account we create here and the one the directory creates are the same human rather
  // than two picker entries (or worse, two humans sharing one name-keyed account). `homePeer`
  // is deliberately NOT set: a redeem does not prove where they live, only a directory does.
  if (!req.albumOwnerId)
    throw new Error(`the origin did not identify the owner of "${album.name}" — cannot mirror it`);
  const hostSlug = `${BOT_PREFIX.person}${req.albumOwnerId}`;
  const host = await ensureUtilityUser(ownerName, {
    peerPub: peer.pub,
    peerUserId: req.albumOwnerId,
    stateKey: hostSlug,
    email: `${hostSlug}@${UTILITY_EMAIL_DOMAIN}`,
  });
  await syncAvatar(host, peer, req.albumOwnerId);

  // Vanilla parity: a view-only share makes local humans VIEWERS, exactly as Immich's own
  // no-upload share links do — an editor role here would let them add photos that silently
  // go nowhere (view-only mirrors never push). Contribute shares map to editor.
  const memberRole = permissions === 'contribute' ? 'editor' : 'viewer';
  const addMembers = async (albumId: string) => {
    let members = (await immichJson('/admin/users')).filter(u => !isUtilityEmail(u.email));
    if (forUserIds?.length) members = members.filter(u => forUserIds.includes(u.id));
    const alb = await immichJson(`/albums/${albumId}`, {}, host.apiKey);
    const already = new Set((alb.albumUsers || []).map(au => au.user?.id));
    members = members.filter(u => !already.has(u.id));
    if (members.length)
      await immichJson(
        `/albums/${albumId}/users`,
        {
          ...jsonBody({ albumUsers: members.map(u => ({ userId: u.id, role: memberRole })) }),
          method: 'PUT',
        },
        host.apiKey
      );
    return members.length;
  };

  const existing = state.mappings.find(
    mp => mp.role === 'member' && mp.peer === peer.pub && mp.remoteAlbumId === album.id && !mp.dead
  );
  if (existing) {
    const n = await addMembers(existing.albumId);
    if (n) log(`added ${n} member(s) to existing mirror "${existing.albumName}"`);
    return { mapping: existing, created: false };
  }

  // ---- ADOPTION: this person's own album becomes the mapping's local half ----
  // The mapping is not pushed to `state.mappings` until its ledger is seeded, because the moment a
  // loop can see it, `shareableAssets` reads that ledger — and a mapping whose ledger knows nothing
  // about the album's contents offers every one of them back to the household they came from.
  if (req.adopt) {
    const { albumId, ownerUserId, ownerCreds } = req.adopt;
    const adoptable = findAdoptableAlbum(
      { albumName: album.name, peerOwnerUserId: req.albumOwnerId ?? '' },
      await readCallerAlbums(ownerCreds),
      ownerUserId
    );
    // The id came from a panel, so it is checked against the caller's OWN albums: only the album
    // this person owns, carrying the offered name, may be adopted. Anything else joins normally.
    if (!adoptable || adoptable.albumId !== albumId)
      throw new Error(`"${album.name}" is not this person's album to reunite — refusing to adopt it`);
    // The sidecar reads the album as the house bot, so the bot must be a member first. Added on the
    // owner's own credential, from their own request: the membership is their act, not one we take.
    await addHouseBotToAlbum(albumId, ownerCreds);
    // The stubs' own accounts need a membership only the album's owner can grant, and this request
    // is the only place that credential exists — see sync/album-grant.ts.
    await grantAlbumWriters(
      albumId,
      ownerCreds,
      peer,
      await peerContributors(peer, req.remoteMappingId || album.id)
    );
    await grantInvitedHumans(albumId, ownerCreds, forUserIds || [], memberRole);
    const hostSlug = `${BOT_PREFIX.house}bot`;
    const hostKey = state.contributors[hostSlug]?.apiKey;
    if (!hostKey) throw new Error('house bot has no key after provisioning — cannot read the album');
    const assets = (await readAlbumAssetsAs(albumId, { source: 'mapping', key: hostKey })) ?? [];
    const mapping: Mapping = {
      id: crypto.randomUUID(),
      role: 'member',
      albumId,
      albumName: adoptable.name,
      peer: peer.pub,
      remoteAlbumId: album.id,
      remoteMappingId: req.remoteMappingId,
      permissions,
      hostSlug,
      via: req.via ?? 'link',
      adopted: true,
      // ADOPTING IS REUNIFYING, so this records the act rather than only echoing what the origin
      // claimed. The panel lists reunified albums by this field, so without it a person who reunited
      // from the accept page has no Un-reunite to undo it with — while that page's own copy promises
      // them one. The wire flag still travels for an ordinary mirror (below), where it is the only
      // thing that can say the share is part of a reunion.
      reunified: true,
    };
    // Seeded rows carry no origin asset, so the deletion sweep skips them: these are this person's
    // own photos, and a peer withdrawing its copy must never remove them.
    for (const row of seedRowsFor(assets, mapping.id)) seenAdd(mapping.id, row.checksum, row.localAsset);
    state.mappings.push(mapping);
    save();
    log(
      `reunited "${adoptable.name}" with "${peer.name}" — ${assets.length} photo(s) already here, seeded so none is offered back`
    );
    await auditLine(
      mapping.id,
      albumId,
      'reunited',
      `Reunited with "${peer.name}" — photos both sides hold now show once. Undo any time from your shared-albums page.`
    );
    return { mapping, created: true };
  }
  let mirror;
  for (let attempt = 1; ; attempt++) {
    try {
      mirror = await immichJson(
        '/albums',
        jsonBody({
          albumName: CFG.mirrorAlbumTemplate.replaceAll('{name}', album.name).replaceAll('{peer}', peer.name),
        }),
        host.apiKey
      );
      break;
    } catch (e) {
      log(`mirror album create attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 6) throw e;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  try {
    const n = await addMembers(mirror.id);
    log(
      `mirror shared with ${forUserIds?.length ? forUserIds.length + ' named user(s)' : n + ' household member(s)'}`
    );
  } catch (e) {
    log(`could not add local members to mirror: ${e.message}`);
  }

  const mapping: Mapping = {
    id: crypto.randomUUID(),
    role: 'member',
    albumId: mirror.id,
    albumName: mirror.albumName,
    peer: peer.pub,
    remoteAlbumId: album.id,
    remoteMappingId: req.remoteMappingId,
    permissions,
    hostSlug,
    via: req.via ?? 'link',
    ...(req.reunified ? { reunified: true } : {}),
  };
  state.mappings.push(mapping);
  save();
  return { mapping, created: true };
}

/**
 * Fill the mirror in behind the caller's answer. Deliberately unawaited by callers: a large
 * album or a video transcode must not hold the accept page (or a poll cycle) hostage.
 */
export function fillMirrorInBackground(mapping: Mapping, peer: Peer) {
  // `void`: deliberately not awaited — a large album or a transcode must not block the caller.
  void (async () => {
    try {
      await reconcileMapping(mapping, peer);
      await pullCanonicalComments(mapping, peer);
    } catch (e) {
      log(`post-join sync error: ${e.message} — the loops will retry`);
    }
  })();
}

/**
 * Replace a share's mirror with an album the person already owns — the panel's Reunite.
 *
 * Distinct from adopting at acquisition time: the share already exists, so this MOVES a mapping
 * rather than creating one. Ordering is the whole of it:
 *
 *  1. prove the requested album is theirs and is the album this share is about;
 *  2. let the house bot in, so the album can be read at all;
 *  3. seed the ledger from the album being adopted, WHILE the mapping still points at the mirror —
 *     so no loop can read a ledger that does not yet describe the album it will point at;
 *  4. move the mapping and mark it;
 *  5. only then remove what the mirror held.
 *
 * A failure after step 4 costs the mirror's stubs, which are ours and re-materialise; a failure
 * before it changes nothing. The mirror album itself is deleted only when it was ours to delete,
 * which is what `albumTeardown` decides.
 */
export async function unifyOwnAlbum(
  mapping: Mapping,
  request: { albumName: string },
  ownerCreds: Creds,
  ownerUserId: string
): Promise<{ album: string; seeded: number }> {
  const own = canUnifyOwnAlbum(mapping, request, await readCallerAlbums(ownerCreds), ownerUserId);
  if (!own) throw new Error(`"${mapping.albumName}" cannot be reunited with that album`);

  await addHouseBotToAlbum(own.albumId, ownerCreds);
  const hostSlug = `${BOT_PREFIX.house}bot`;
  const hostKey = state.contributors[hostSlug]?.apiKey;
  if (!hostKey) throw new Error('house bot has no key after provisioning — cannot read the album');

  const assets = (await readAlbumAssetsAs(own.albumId, { source: 'mapping', key: hostKey })) ?? [];
  const previousAlbumId = mapping.albumId;
  const previousHostSlug = mapping.hostSlug;

  // Seeded before the move, so the mapping is never visible with a ledger that describes a
  // different album — that is the state that offers an album's whole contents back to its origin.
  for (const row of seedRowsFor(assets, mapping.id)) seenAdd(mapping.id, row.checksum, row.localAsset);

  mapping.albumId = own.albumId;
  mapping.albumName = own.name;
  mapping.hostSlug = hostSlug;
  mapping.adopted = true;
  mapping.reunified = true;
  save();
  log(`reunited "${own.name}" — ${assets.length} photo(s) were already here, seeded so none is offered back`);

  await retireMirror(mapping, previousAlbumId, previousHostSlug);
  // RE-SEED, and it has to be after the retire. `seenAdd` is INSERT OR IGNORE on (mapping,
  // checksum), so when the peer and the owner both hold a photo — the co-owned case this feature is
  // built for — the mirror's row was already there and the owner's own asset got no row at all.
  // retireMirror has just dropped that row, so without this pass the checksum is claimed by nobody,
  // `seenHas` is false, the album-level suppression finds nothing, and the next reconcile
  // materialises a stub right beside the person's own photo.
  for (const row of seedRowsFor(assets, mapping.id)) seenAdd(mapping.id, row.checksum, row.localAsset);

  // The trail, left once the move is done and the bot is a member — it was granted above, on the
  // owner's credential, which is the only moment an album belonging to a human can gain it.
  await auditLine(
    mapping.id,
    own.albumId,
    'reunited',
    `Reunited with "${state.peers.find(p => p.pub === mapping.peer)?.name ?? 'a linked server'}" — photos ` +
      `both sides hold now show once. Undo any time from your shared-albums page.`
  );

  // Kick the reconcile off, but do NOT await it: the album must be reunited the moment the move is
  // made, and awaiting a peer call would make the move's latency someone else's uptime.
  //
  // Clearing the cursor first makes the pull do work: `reconcileMapping` returns early when the
  // origin's version is unchanged, and moving an album changes nothing at the origin.
  const peer = state.peers.find(p => p.pub === mapping.peer);
  if (peer) {
    // Same grant as acquisition-time adoption, and for the same reason: the contributor accounts
    // that will own this album's stubs can only be given a membership by its owner, who is present
    // here and nowhere else. A peer that cannot be reached now grants nothing and must not fail the
    // reunion — `peerContributors` returns empty instead.
    await grantAlbumWriters(
      own.albumId,
      ownerCreds,
      peer,
      await peerContributors(peer, mapping.remoteMappingId || mapping.remoteAlbumId)
    );
    await grantInvitedHumans(
      own.albumId,
      ownerCreds,
      mapping.forPeerUserIds || [],
      mapping.permissions === 'contribute' ? 'editor' : 'viewer'
    );
    delete mapping.remoteVersion;
    save();
    // `void`: deliberately unawaited. The loops retry, so a lost pull costs a tick, not the move.
    void reconcileMapping(mapping, peer).catch(e =>
      log(`post-reunion reconcile for "${own.name}": ${e.message} — the loops will retry`)
    );
  }
  if (CFG.reconcileDebug)
    log(
      `DBG reunion landed: mapping.albumId=${mapping.albumId.slice(0, 8)} was=${previousAlbumId.slice(0, 8)} name="${own.name}"`
    );
  return { album: own.name, seeded: assets.length };
}

/** Remove what the mirror held. Its stubs are ours and the ledger says so, so removal is
 *  reclaiming space rather than destroying anyone's photo; the album goes only if it was ours. */
async function retireMirror(mapping: Mapping, mirrorAlbumId: string, mirrorHostSlug?: string) {
  let removed = 0;
  for (const entry of store.seenForMapping(mapping.id)) {
    if (!entry.originAsset) continue;
    const owner = store.ledgerByAsset(entry.localAsset);
    if (!owner || owner.mapping !== mapping.id) continue;
    // FORGET THE ROW FIRST, then delete the stub. The order is the whole point, and the reverse
    // order is a bug: reconcile skips any ref the ledger already knows (`seenHas`), so a row left
    // behind because a delete failed keeps the photo from ever being materialised into the album
    // the mapping now points at — and every retry is skipped for the same reason. Recording the
    // intent first makes a failed delete merely an orphaned stub (reclaimable, and the loops keep
    // trying) rather than an album that can never be completed.
    //
    // Unlike a teardown, which keeps row and asset in step because the share is ending, here the
    // share moved: the photo still belongs to it, and forgetting the row is what lets reconcile
    // put it where the mapping now looks.
    store.seenRemoveEntry(mapping.id, entry.checksum);
    if (await deleteProxyAsset(entry.localAsset)) removed++;
    else log(`could not remove the replaced copy of one photo — the loops will retry`);
  }
  const plan = albumTeardown({ role: 'member', albumName: mapping.albumName });
  const key = mirrorHostSlug ? state.contributors[mirrorHostSlug]?.apiKey : undefined;
  if (plan.deleteAlbum && key)
    await callAs({ source: 'mapping', key }, `/albums/${mirrorAlbumId}`, { method: 'DELETE' }).catch(e =>
      log(`could not remove the replaced mirror: ${e.message}`)
    );
  if (removed) log(`reclaimed ${removed} stub(s) from the replaced mirror`);
}
