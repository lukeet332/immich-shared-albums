/**
 * immich/access.ts — whose Immich credential reads a local album.
 *
 * The sidecar holds three kinds of credential and they are NOT interchangeable:
 *
 *   - the configured admin key — the household's own key, reaches its own albums;
 *   - a person's stand-in key (a `Contributor`) — the utility account the sidecar created for
 *     someone on a linked server, which OWNS the mirror albums standing in for their album;
 *   - a caller's forwarded headers — a real Immich session or key belonging to a user of THIS
 *     server, used when a per-user surface must be answered on that person's own authority.
 *
 * Reading an album with the wrong one is silent, not loud: Immich answers
 * `400 Not found or no album.read access`, so a caller that wraps the read in a try/catch sees
 * "no albums" rather than an error. That is what made member mirrors die after five failed
 * watch cycles, and what would make a per-user panel show nothing to the person it is for.
 * So the decision lives here, once, and the fallbacks that produced it are unrepresentable:
 * a member mapping read as the admin is not a thing this module can return.
 */
import { state } from '../state.ts';
import { immichJson, jsonBody } from './client.ts';

/** Credentials forwarded on behalf of a signed-in caller, exactly as Immich receives them. */
export type Creds = { headers: Record<string, string> };

/** Which credential reads an album, as a closed set of shapes rather than two optional fields:
 *  a read can never carry both a key and forwarded headers, and can never carry neither — which
 *  would fall through to the admin key. */
export type AlbumAccess =
  { source: 'admin' } | { source: 'mapping'; key: string } | { source: 'caller'; creds: Creds };

export type MappingCredentials = {
  role: 'owner' | 'member';
  hostSlug?: string;
  albumName?: string;
  id?: string;
};

/** Headers that carry a caller's identity. One list, because a second copy drifts. */
const CRED_HEADER_NAMES = ['cookie', 'x-api-key', 'authorization'] as const;

/** A caller's Immich credential as forwarded headers, or null when they sent none. */
export function credsFromHeaders(headers: Record<string, unknown>): Creds | null {
  const out: Record<string, string> = {};
  for (const name of CRED_HEADER_NAMES) if (headers[name]) out[name] = headers[name] as string;
  return Object.keys(out).length ? { headers: out } : null;
}

/** The key the local side of a mapping must be read with.
 *
 *  A member mirror is owned by the stand-in for the origin's album owner, and a per-person
 *  invitation adds only the invited human — so the household admin may not be a member and Immich
 *  refuses it the album. An owner mapping IS this household's album, so the admin key is the
 *  correct one there.
 *
 *  A member mapping whose host key is missing is not answerable: returning the admin key would
 *  reproduce the exact refusal this exists to avoid. */
export function readCredsFor(mapping: MappingCredentials): AlbumAccess {
  if (mapping.role !== 'member') return { source: 'admin' };
  const key = mapping.hostSlug ? state.contributors[mapping.hostSlug]?.apiKey : undefined;
  if (!key)
    throw new Error(
      `mapping "${mapping.albumName}" (${mapping.id}) has no host key — refusing to read its mirror with the admin key`
    );
  return { source: 'mapping', key };
}

/** The key form of an access, for a WRITE (a comment, an activity, a membership the stand-in
 *  must make). Only the mapping shape carries a key, so this is the one place that decides it. */
export function albumReadKey(access: AlbumAccess): string | undefined {
  return access.source === 'mapping' ? access.key : undefined;
}

/** Any Immich call made under an access — the read paths below, and callers that need a VERB
 *  (`DELETE`, `PUT`) rather than one of them. */
export const callAs = (access: AlbumAccess, path: string, init?: RequestInit) => call(access, path, init);

/** `source: 'admin'` passes no key on purpose — `immichJson`'s default IS the admin key, and
 *  saying so here is the whole distinction this module owns. */
const call = (access: AlbumAccess, path: string, init?: RequestInit) => {
  switch (access.source) {
    case 'admin':
      return immichJson(path, init);
    case 'mapping':
      return immichJson(path, init, access.key);
    case 'caller':
      return immichJson(path, init, access.creds);
  }
};

/** The local album as the given access can see it, or undefined when it cannot.
 *
 *  Undefined is the point: a caller cannot go on to read `albumUsers` off a refusal, which is how
 *  a panel ends up filtering a plan it never had. */
export const readAlbumAs = (id: string, access: AlbumAccess) =>
  call(access, `/albums/${id}?withoutAssets=true`).catch(() => undefined);

/** Every asset the access can see in the album, or undefined when it cannot see the album at all.
 *
 *  An empty album and a refused read are different answers and must not share one: collapsing them
 *  is the silent failure this module exists to remove. */
export async function readAlbumAssetsAs(albumId: string, access: AlbumAccess): Promise<any[] | undefined> {
  const out: any[] = [];
  let page = 1;
  while (page) {
    const res = await call(
      access,
      '/search/metadata',
      jsonBody({ albumIds: [albumId], page, size: 500, withExif: true })
    ).catch(() => null);
    if (!res) return undefined;
    out.push(...(res.assets?.items || []));
    page = res.assets?.nextPage ? Number(res.assets.nextPage) : 0;
  }
  return out;
}

/** The albums a caller may see, by id. Immich scopes the list to the credential, so this is the
 *  caller's own membership — not a list to filter for them. */
export async function visibleAlbumIds(creds: Creds): Promise<Set<string>> {
  const mine = await immichJson('/albums', {}, creds);
  return new Set((mine || []).map((a: { id: string }) => a.id));
}
