/** sync/album-grant.ts — granting a reunified album's writers their membership, on the owner's credential. See sync-loops.md. */

import { isUtilityEmail, log } from '../config.ts';
import type { Creds } from '../immich/access.ts';
import { jsonBody, immichJson } from '../immich/client.ts';
import { ensureContributor } from '../immich/contributors.ts';
import { peerRequest, withDeadline } from '../p2p/transport.ts';
import type { Peer } from '../store.ts';

/** A reunion is a person waiting on a page, so the manifest pull that feeds the grant gets seconds,
 *  not the transport's full `DEADLINE_MS`: a peer that cannot answer that quickly cannot be granted
 *  on this request, and the panel is where the owner can run it again. */
const GRANT_MANIFEST_DEADLINE_MS = 8_000;

/** One person on the origin, as the peer's own refs name them. */
export type PeerContributor = { originUserId: string; displayName: string };

/**
 * The distinct contributors the peer currently offers for an album.
 *
 * A ref names its contributor by id on the origin server, which is what `person-<id>` is keyed on.
 * Returns empty rather than throwing: a peer that cannot be reached right now must not fail the
 * reunion that is in progress — the reconcile sweep reports the gap instead.
 */
export async function peerContributors(
  peer: Peer,
  remoteTarget: string | undefined
): Promise<PeerContributor[]> {
  if (!remoteTarget) return [];
  const r = await withDeadline(
    peerRequest(peer, `/albums/${remoteTarget}/manifest`),
    `grant manifest from "${peer.name}"`,
    GRANT_MANIFEST_DEADLINE_MS
  ).catch(() => null);
  if (!r || r.status >= 400) return [];
  const distinct = new Map<string, PeerContributor>();
  for (const ref of r.json?.manifest ?? []) {
    const originUserId = ref?.contributor?.originUserId;
    if (originUserId && !distinct.has(originUserId))
      distinct.set(originUserId, {
        originUserId,
        displayName: ref.contributor.displayName || peer.name,
      });
  }
  return [...distinct.values()];
}

/**
 * Add the accounts that will own a reunified album's mirrored stubs, as album EDITORS.
 *
 * Only the album's owner can add a member, and the owner's credentials exist in exactly one place:
 * the request in which they reunified. So every contributor the peer offers is granted HERE, at
 * adoption, rather than lazily during a reconcile that has no owner credential to offer — which is
 * what a 403 `albumUser.create` on every cycle looked like from the outside.
 *
 * EDITOR, where the house bot is a VIEWER: these accounts upload the stubs they own, and Immich
 * refuses that with `albumAsset.create` for anything less. `ensureContributor` is reused whole, on
 * the owner's credentials, so the account is provisioned and placed by one code path.
 *
 * A contributor the peer only starts offering later is NOT covered — nothing can grant them a
 * membership without the owner present. `ensureContributor` logs the refusal, and the panel's
 * reunion list is the surface that can re-run this with an owner in the loop.
 */
export async function grantAlbumWriters(
  albumId: string,
  ownerCreds: Creds,
  peer: Peer,
  contributors: PeerContributor[]
): Promise<number> {
  let granted = 0;
  for (const contributor of contributors) {
    try {
      await ensureContributor(
        contributor.displayName,
        albumId,
        ownerCreds,
        peer,
        contributor.originUserId,
        peer.pub
      );
      granted++;
    } catch (e) {
      log(
        `could not grant "${contributor.displayName}" access to album ${albumId.slice(0, 8)}: ${(e as Error).message}`
      );
    }
  }
  return granted;
}

/**
 * Add the local people an invitation NAMES, on the owner's credential — the same authority problem
 * as the stub accounts, one call site over. `syncMirrorMembers` widens a mirror with the stand-in
 * key, which an adopted album answers with `403 albumUser.create`, so the people the share is for
 * are placed here, at adoption, while the album's owner is in the request.
 */
export async function grantInvitedHumans(
  albumId: string,
  ownerCreds: Creds,
  userIds: string[],
  role: 'viewer' | 'editor'
): Promise<number> {
  if (!userIds.length) return 0;
  const album = await immichJson(`/albums/${albumId}?withoutAssets=true`, {}, ownerCreds);
  const already = new Set((album?.albumUsers || []).map((au: any) => au.user?.id));
  const add = userIds.filter(id => !already.has(id));
  if (!add.length) return 0;
  await immichJson(
    `/albums/${albumId}/users`,
    { ...jsonBody({ albumUsers: add.map(id => ({ userId: id, role })) }), method: 'PUT' },
    ownerCreds
  );
  return add.length;
}

/**
 * Take our accounts back off an album we are no longer reunified with.
 *
 * The mirror of `grantAlbumWriters`, and it runs for the same reason: only the album's owner can
 * change its membership, and the request that un-reunifies is the only place that credential exists.
 * Every utility account on an adopted album is one we put there — the album is a person's own, so it
 * had none before the reunion — and leaving them behind keeps the sidecar's read access to a private
 * album AND makes it look like a live mirror to anything enumerating albums by stand-in key.
 */
export async function stripAlbumBots(albumId: string, ownerCreds: Creds): Promise<number> {
  const album = await immichJson(`/albums/${albumId}?withoutAssets=true`, {}, ownerCreds);
  const ours = (album?.albumUsers || []).filter(
    (au: any) => au.user?.id && au.role !== 'owner' && isUtilityEmail(au.user.email || '')
  );
  let removed = 0;
  for (const au of ours) {
    try {
      await immichJson(`/albums/${albumId}/user/${au.user.id}`, { method: 'DELETE' }, ownerCreds);
      removed++;
    } catch (e) {
      log(`could not take our account off album ${albumId.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
  return removed;
}
