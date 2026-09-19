/** web/ui/pages/accept/fragment.ts — the invite rides the URL fragment so it never reaches server logs; query form is the fallback. See ../../../http-router.md. */
export type Invite = {
  /** The origin's endpoint token: base64url {pub, relay?, addrs?}, minted by its share page. */
  endpointToken: string;
  key: string;
  /** The album's name, when the share page sent it. Only used to ask whether the person already
   *  owns an album by that name, so a share page too old to send one simply offers no reunion. */
  albumName?: string;
};

const fromParts = (
  endpointToken?: string | null,
  key?: string | null,
  albumName?: string | null
): Invite | null =>
  endpointToken && key ? { endpointToken, key, ...(albumName ? { albumName } : {}) } : null;

export const readInvite = (): Invite | null => {
  try {
    if (location.hash.length > 1) {
      const f = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      if (f?.v === 2) return fromParts(f.e, f.key, f.a);
    }
  } catch {
    // fall through to the query form
  }
  const qp = new URLSearchParams(location.search);
  const invite = fromParts(qp.get('e'), qp.get('k'));
  if (invite) history.replaceState({}, '', location.pathname);
  return invite;
};
