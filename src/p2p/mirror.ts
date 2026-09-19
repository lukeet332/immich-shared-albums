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
import { state, save, seenAdd } from '../state.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { readAlbumAssetsAs, readCallerAlbums, type Creds } from '../immich/access.ts';
import { ensureUtilityUser, syncAvatar } from '../immich/contributors.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { findAdoptableAlbum } from '../sync/adoption.ts';
import { addHouseBotToAlbum } from '../sync/house-bot.ts';
import { seedRowsFor } from '../sync/matches.ts';
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
      ...(req.reunified ? { reunified: true } : {}),
    };
    // Seeded rows carry no origin asset, so the deletion sweep skips them: these are this person's
    // own photos, and a peer withdrawing its copy must never remove them.
    for (const row of seedRowsFor(assets, mapping.id)) seenAdd(mapping.id, row.checksum, row.localAsset);
    state.mappings.push(mapping);
    save();
    log(
      `reunited "${adoptable.name}" with "${peer.name}" — ${assets.length} photo(s) already here, seeded so none is offered back`
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
