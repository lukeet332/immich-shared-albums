/** sync/comments.ts — cross-server comment sync. The origin album is the source of truth;. See sync-loops.md. */
import { CFG, log, ROUTE_PREFIX, personName } from '../config.ts';
import { state, save, seenActHas, seenActAdd, keys } from '../state.ts';
import { sign, signedFetch, nudgePeers, callingPeer, mappingFor } from '../peers.ts';
import { immichJson, jsonBody, usersById } from '../immich/client.ts';
import { ensureContributor } from '../immich/contributors.ts';

export const getComments = (albumId, key?: string) =>
  immichJson(`/activities?albumId=${albumId}&type=comment`, {}, key);

const albumReaderKey = mapping =>
  mapping.role === 'member' && mapping.adminSlug ? state.contributors?.[mapping.adminSlug]?.key : undefined;
export const postComment = (albumId, comment, key) =>
  immichJson('/activities', jsonBody({ albumId, type: 'comment', comment }), key);
export async function materialiseComments(mapping, peerUrl, peerName, comments) {
  const users = await usersById();
  const local = await getComments(mapping.albumId, albumReaderKey(mapping));
  const localPairs = new Set(
    local.map(a => {
      const authorName = personName(users[a.user?.id]?.name || a.user?.name || '');
      return `${authorName}\u0000${a.comment}`;
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
    const author = await ensureContributor(
      cm.author || peerName,
      mapping.albumId,
      adminKey,
      peerUrl,
      cm.authorUserId,
      mapping.peer
    );
    const posted = await postComment(mapping.albumId, cm.comment, author.key);
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
  if (Object.keys(ids).length) nudgePeers(mapping.albumId, peer.pub);
  return [200, { ok: true, ids }];
}
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
      author: personName(users[a.user?.id]?.name || a.user?.name || CFG.name) || CFG.name,
      authorUserId: a.user?.id,
    }));
  return [200, { comments }];
}
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
      const pushResponse = await signedFetch(
        `${peer.url}${ROUTE_PREFIX}/api/v1/albums/${targetMapping}/activity`,
        JSON.stringify({ comments: payload })
      );
      if (pushResponse.ok) {
        comments.forEach(a => seenActAdd(`local:${a.id}`));
        const { ids = {} } = await pushResponse.json().catch(() => ({}));
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
export async function pullCanonicalComments(mapping, peer) {
  const target = mapping.remoteMappingId || mapping.remoteAlbumId;
  const sig = { headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(target) } };
  const versionResponse = await fetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${target}/version`, {
    ...sig,
    signal: AbortSignal.timeout(15000),
  });
  if (!versionResponse.ok) return;
  const versionAnswer = await versionResponse.json().catch(() => ({}));
  if (versionAnswer.comments == null || versionAnswer.comments === mapping.remoteCommentCount) return;
  const commentsResponse = await fetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${target}/comments`, {
    ...sig,
    signal: AbortSignal.timeout(20000),
  });
  if (!commentsResponse.ok) return;
  const { comments = [] } = await commentsResponse.json().catch(() => ({}));
  await materialiseComments(mapping, peer.url, peer.name, comments);
  mapping.remoteCommentCount = versionAnswer.comments;
  save();
}

export function startCommentLoop() {
  setInterval(
    () => syncComments().catch(e => log('comment loop:', e.message)),
    Number(process.env.COMMENT_POLL_MS || 5000)
  );
}
