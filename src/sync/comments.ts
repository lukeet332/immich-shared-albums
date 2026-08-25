/**
 * sync/comments.ts — cross-server comment sync. The origin album is the source of truth;
 * members pull the canonical list and push their own, gated by a cheap activity-count
 * statistic so messages land in seconds without heavy polling. startCommentLoop runs it.
 */
import { CFG, log, personName } from '../config.ts';
import { state, save, seenActHas, seenActAdd } from '../state.ts';
import { nudgePeers, peerByPub, mappingFor } from '../peers.ts';
import { peerRequest } from '../p2p/transport.ts';
import { immichJson, jsonBody, usersById } from '../immich/client.ts';
import { ensureContributor } from '../immich/contributors.ts';

export const getComments = (albumId, key?: string) =>
  immichJson(`/activities?albumId=${albumId}&type=comment`, {}, key);

/**
 * Whose credential can read this album's activity.
 *
 * For a mirror, the admin key is NOT a safe default: a per-person invitation adds only the one
 * invited human, so the sidecar's own admin may not be a member and Immich answers
 * `400 Not found or no album.read access` on every poll. The mirror-owning stand-in always has
 * access because it owns the album. Owner mappings keep the admin key (undefined => default).
 */
const albumReaderKey = mapping =>
  mapping.role === 'member' && mapping.hostSlug ? state.contributors[mapping.hostSlug]?.apiKey : undefined;
export const postComment = (albumId, comment, key) =>
  immichJson('/activities', jsonBody({ albumId, type: 'comment', comment }), key);
// Materialise foreign comments locally via the author's utility user, skipping ids
// already seen.
export async function materialiseComments(mapping, peer, comments) {
  const ids = {};
  for (const cm of comments) {
    const tag = `remote:${cm.id}`;
    if (seenActHas(tag)) continue;
    const hostKey = mapping.hostSlug ? state.contributors[mapping.hostSlug]?.apiKey : undefined;
    const c = await ensureContributor(
      cm.author || peer.name,
      mapping.albumId,
      hostKey,
      peer,
      cm.authorUserId,
      mapping.peer
    );
    const posted = await postComment(mapping.albumId, cm.comment, c.apiKey);
    ids[cm.id] = posted.id;
    seenActAdd(tag, mapping.id);
    seenActAdd(`local:${posted.id}`, mapping.id); // don't echo it back
    log(`synced comment from "${cm.author}" into "${mapping.albumName}"`);
  }
  return ids;
}
export async function handleActivity(callerPub: string, body: string, albumMappingId: string) {
  const peer = peerByPub(callerPub);
  if (!peer) return [403, { error: 'unknown peer', code: 'unknown_peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping', code: 'unknown_mapping' }];
  // DELIBERATELY no permissions gate (decided 2026-08-24): view-only governs PHOTOS, not
  // conversation. A shared album is still a shared space to talk in — revoking upload
  // rights must not mute anyone. Tightening this would be a visible cross-server change.
  const { comments = [] } = JSON.parse(body);
  const ids = await materialiseComments(mapping, peer, comments);
  if (Object.keys(ids).length) nudgePeers(mapping.albumId, peer.pub); // new messages — tell the others
  return [200, { ok: true, ids }];
}
// Canonical comment list for an album — the origin is the source of truth for messages.
// Utility-authored entries resolve back to the true contributor's name.
export async function handleComments(callerPub: string, albumMappingId: string) {
  const peer = peerByPub(callerPub);
  if (!peer) return [403, { error: 'unknown peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const users = await usersById();
  // Strip the "(via …)" decoration only from BOT authors — a human genuinely named with a
  // trailing parenthesis must travel as written.
  const authorName = (u: { id?: string; name?: string } | undefined) => {
    const rec = u?.id ? users[u.id] : undefined;
    const raw = rec?.name || u?.name || CFG.name;
    return (rec?.utility ? personName(raw) : raw) || CFG.name;
  };
  const comments = (await getComments(mapping.albumId))
    .filter(a => a.comment)
    .map(a => ({
      id: a.id,
      comment: a.comment,
      createdAt: a.createdAt,
      author: authorName(a.user),
      authorUserId: a.user?.id,
    }));
  return [200, { comments }];
}
// push locally-authored comments (not ones we materialised) to the peer.
// Runs on its own fast cadence; the cheap activity-count statistic gates the real work,
// so cross-server comments land in seconds without heavy polling.
export let COMMENTS_RUNNING = false;
export async function syncComments() {
  if (COMMENTS_RUNNING) return;
  COMMENTS_RUNNING = true;
  try {
    await syncCommentsOnce();
  } finally {
    COMMENTS_RUNNING = false;
  }
}
export async function syncCommentsOnce() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;
    try {
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      if (mapping.role === 'member') await pullCanonicalComments(mapping, peer);
      const stats = await immichJson(
        `/activities/statistics?albumId=${mapping.albumId}`,
        {},
        albumReaderKey(mapping)
      ).catch(() => null);
      if (stats && stats.comments === mapping.commentCount) continue;
      const utilityIds = new Set(Object.values(state.contributors).map(c => c.userId));
      const comments = (await getComments(mapping.albumId, albumReaderKey(mapping))).filter(
        a =>
          a.comment &&
          !seenActHas(`local:${a.id}`) &&
          !seenActHas(`remote:${a.id}`) &&
          !utilityIds.has(a.user?.id)
      );
      if (!comments.length) {
        if (stats) {
          mapping.commentCount = stats.comments;
          save();
        }
        continue;
      }
      const targetMapping =
        mapping.role === 'member' ? mapping.remoteMappingId || mapping.remoteAlbumId : mapping.albumId;
      const payload = comments.map(a => ({
        id: a.id,
        comment: a.comment,
        author: a.user?.name || CFG.name,
        authorUserId: a.user?.id,
      }));
      const r = await peerRequest(peer, `/albums/${targetMapping}/activity`, { comments: payload });
      if (r.status < 400) {
        comments.forEach(a => seenActAdd(`local:${a.id}`, mapping.id));
        // the origin answers with canonical ids for our comments — remember them so the
        // canonical pull can never hand us our own comments back
        const { ids = {} } = r.json ?? {};
        for (const originId of Object.values(ids)) seenActAdd(`remote:${originId}`, mapping.id);
        if (stats) {
          mapping.commentCount = stats.comments;
          save();
        }
        log(`pushed ${comments.length} comment(s) to "${peer.name}"`);
      }
    } catch (e) {
      log(`comment sync error on "${mapping.albumName}": ${e.message}`);
    }
  }
}
// The origin is the source of truth for messages: members pull its canonical comment set
// (gated by the comment count in the version handshake) and materialise what's missing.
// This is also what relays member comments onward to other member households.
export async function pullCanonicalComments(mapping, peer) {
  const target = mapping.remoteMappingId || mapping.remoteAlbumId;
  const vr = await peerRequest(peer, `/albums/${target}/version`).catch(() => null);
  if (!vr || vr.status >= 400) return;
  const v = vr.json ?? {};
  if (v.comments == null || v.comments === mapping.remoteCommentCount) return;
  const cr = await peerRequest(peer, `/albums/${target}/comments`).catch(() => null);
  if (!cr || cr.status >= 400) return;
  const { comments = [] } = cr.json ?? {};
  await materialiseComments(mapping, peer, comments);
  mapping.remoteCommentCount = v.comments;
  save();
}

// comments ride a fast lane: the count statistic is one indexed query, so seconds-level
// cadence stays cheap even on low-power hosts; the full activity fetch only runs on change
export function startCommentLoop() {
  setInterval(() => syncComments().catch(e => log('comment loop:', e.message)), CFG.commentPollMs);
}
