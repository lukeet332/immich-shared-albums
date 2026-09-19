/** sync/album-invite.ts — the panel's Invite: putting the peer's person on the caller's OWN album, which is what starts a reunion. See sync-loops.md. */

import { log } from '../config.ts';
import type { Creds } from '../immich/access.ts';
import { readCallerAlbums } from '../immich/access.ts';
import { ensureContributor } from '../immich/contributors.ts';
import { state, store } from '../state.ts';
import type { Peer } from '../store.ts';
import { refreshPeerAlbums } from './album-index.ts';
import { findAdoptableAlbum } from './adoption.ts';
import { addHouseBotToAlbum } from './house-bot.ts';
import { auditLine } from './audit.ts';
import { detectInvitesOnce } from './invites.ts';
import { normaliseAlbumName } from './matches.ts';

/**
 * Share the caller's album with the person on the peer who owns the other half.
 *
 * The same act Immich's own picker performs — one membership, for one account, on the caller's own
 * album, on the caller's own credential — done from the panel so a person does not have to leave it.
 * It is what the row used to instruct them to go and do, and it grants nothing wider: the account is
 * a viewer of one album, and the caller asked for it by clicking.
 *
 * The person is addressed by their id on THEIR server, and only if the peer's own published index
 * names them for an album of that name. A request cannot invent a person to share with, and the
 * album is re-derived from the caller's own Immich list, never taken from the body.
 */
export async function invitePeerToReunite(
  creds: Creds,
  callerUserId: string,
  peer: Peer,
  asked: { albumName: string; ownerUserId: string }
): Promise<{ album: string; invited: string }> {
  const wanted = normaliseAlbumName(asked.albumName || '');
  // Read the peer's index the way the panel does before reading it: the row was rendered from an
  // index this server refreshed, but that may be minutes old by the time someone clicks, and a peer
  // that has since published the album would otherwise be refused by our own staleness.
  await refreshPeerAlbums(peer).catch(() => store.publishedAlbumsFor(peer.pub, 'from-them'));
  const theirs = store
    .publishedAlbumsFor(peer.pub, 'from-them')
    .find(a => a.ownerUserId === asked.ownerUserId && normaliseAlbumName(a.name) === wanted);
  if (!theirs) throw new Error('that pairing is not in this server’s index — open the panel again and retry');

  const mine = findAdoptableAlbum(
    { albumName: asked.albumName, peerOwnerUserId: asked.ownerUserId },
    await readCallerAlbums(creds),
    callerUserId
  );
  if (!mine) throw new Error(`you have no album called “${asked.albumName}”`);

  // The membership IS the invitation, so it is added the way a human's would be and the ordinary
  // scanner turns it into one — the same path, the same mapping, the same everything. Two things
  // make that work: `invitation` keeps it out of the attribution ledger (`addedRecord`), and
  // `homePeer` is set because the peer's own published index named this person as that album's owner
  // THERE, which is the same proof a directory exchange gives.
  await ensureContributor(
    theirs.ownerName || `someone on ${peer.name}`,
    mine.albumId,
    creds,
    peer,
    theirs.ownerUserId,
    peer.pub,
    { homePeer: peer.pub, invitation: true }
  );
  // Run the scanner now rather than on its next tick: the mapping it records is what turns the row
  // into "waiting" and tells the peer, and the person is looking at that row.
  await detectInvitesOnce().catch(e => log(`invite: could not re-read memberships yet: ${e.message}`));

  // The trail, in the album's own comments — the same channel and the same call the reunion uses, so
  // the album narrates its own history to everyone in it. The bot has to BE a member to speak, and
  // only an album's owner can make it one: this request is that moment.
  const mapping = state.mappings.find(
    m => m.role === 'owner' && m.peer === peer.pub && m.albumId === mine.albumId && !m.dead
  );
  if (mapping) {
    await addHouseBotToAlbum(mine.albumId, creds).catch(e =>
      log(`could not put the bot on "${mine.name}" to record the invite: ${e.message}`)
    );
    await auditLine(
      mapping.id,
      mine.albumId,
      'invited',
      `Invited ${theirs.ownerName} to reunite this album — the two merge into this one when they accept.`
    );
  }
  return { album: mine.name, invited: theirs.ownerName };
}
