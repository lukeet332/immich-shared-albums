/**
 * sync/comments.ts — cross-server comment sync. The origin album is the source of truth;
 * members pull the canonical list and push their own, gated by a cheap activity-count
 * statistic so messages land in seconds without heavy polling. startCommentLoop runs it.
 */
import { CFG, log, UTILITY_SUFFIX, ROUTE_PREFIX } from '../config.ts';
import { state, save, seenActHas, seenActAdd, keys } from '../state.ts';
import { sign, signedFetch, nudgePeers, callingPeer, mappingFor } from '../peers.ts';
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
  mapping.role === 'member' && mapping.adminSlug ? state.contributors?.[mapping.adminSlug]?.key : undefined;
export const postComment = (albumId, comment, key) =>
  immichJson('/activities', jsonBody({ albumId, type: 'comment', comment }), key);
// Materialise foreign comments locally via the author's utility user. Skips ids already
// seen AND (author, text) pairs already present locally — the latter guards legacy comments
// synced before canonical ids existed.
export async function materialiseComments(mapping, peerUrl, peerName, comments) {
  const users = await usersById();
  const local = await getComments(mapping.albumId, albumReaderKey(mapping));
  const localPairs = new Set(
    local.map(a => {
      const n = (users[a.user?.id]?.name || a.user?.name || '').replace(UTILITY_SUFFIX, '');
      return `${n}\u0000${a.comment}`;
    })
  );
  const ids = {};
  for (const cm of comments) {
    const tag = `remote:${cm.id}`;
    if (seenActHas(tag)) continue;
    if (localPairs.has(`${cm.author}\u0000${cm.comment}`)) {
      seenActAdd(tag);
      continue;
    }
    const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
    const c = await ensureContributor(
      cm.author || peerName,
      mapping.albumId,
      adminKey,
      peerUrl,
      cm.authorUserId,
      mapping.peer
    );
    const posted = await postComment(mapping.albumId, cm.comment, c.key);
    ids[cm.id] = posted.id;
    seenActAdd(tag);
    seenActAdd(`local:${posted.id}`); // don't echo it back
    log(`synced comment from "${cm.author}" into "${mapping.albumName}"`);
  }
  return ids;
}
export async function handleActivity(req, body, albumMappingId) {
  const peer = callingPeer(req, body);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const { comments = [] } = JSON.parse(body);
  const ids = await materialiseComments(mapping, peer.url, peer.name, comments);
  if (Object.keys(ids).length) nudgePeers(mapping.albumId, peer.pub); // new messages — tell the others
  return [200, { ok: true, ids }];
}
// Canonical comment list for an album — the origin is the source of truth for messages.
// Utility-authored entries resolve back to the true contributor's name.
export async function handleComments(req, albumMappingId) {
  const peer = callingPeer(req, albumMappingId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const users = await usersById();
  const comments = (await getComments(mapping.albumId))
    .filter(a => a.comment)
    .map(a => ({
      id: a.id,
      comment: a.comment,
      createdAt: a.createdAt,
      author: (users[a.user?.id]?.name || a.user?.name || CFG.name).replace(UTILITY_SUFFIX, ''),
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
      const utilityIds = new Set(Object.values(state.contributors || {}).map(c => c.userId));
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
      const r = await signedFetch(
        `${peer.url}${ROUTE_PREFIX}/api/v1/albums/${targetMapping}/activity`,
        JSON.stringify({ comments: payload })
      );
      if (r.ok) {
        comments.forEach(a => seenActAdd(`local:${a.id}`));
        // the origin answers with canonical ids for our comments — remember them so the
        // canonical pull can never hand us our own comments back
        const { ids = {} } = await r.json().catch(() => ({}));
        for (const originId of Object.values(ids)) seenActAdd(`remote:${originId}`);
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
  const sig = { headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(target) } };
  const vr = await fetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${target}/version`, {
    ...sig,
    signal: AbortSignal.timeout(15000),
  });
  if (!vr.ok) return;
  const v = await vr.json().catch(() => ({}));
  if (v.comments == null || v.comments === mapping.remoteCommentCount) return;
  const cr = await fetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${target}/comments`, {
    ...sig,
    signal: AbortSignal.timeout(20000),
  });
  if (!cr.ok) return;
  const { comments = [] } = await cr.json().catch(() => ({}));
  await materialiseComments(mapping, peer.url, peer.name, comments);
  mapping.remoteCommentCount = v.comments;
  save();
}

// comments ride a fast lane: the count statistic is one indexed query, so seconds-level
// cadence stays cheap even on low-power hosts; the full activity fetch only runs on change
export function startCommentLoop() {
  setInterval(
    () => syncComments().catch(e => log('comment loop:', e.message)),
    Number(process.env.COMMENT_POLL_MS || 5000)
  );
}
