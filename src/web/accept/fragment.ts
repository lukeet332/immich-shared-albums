/** web/accept/fragment.ts — where the invite details come from. See ../http-router.md. */
export type Invite = { host: string; scheme: string; key: string };

export const readInvite = (): Invite | null => {
  try {
    if (location.hash.length > 1) {
      const fragment = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      if (fragment?.host && fragment?.key)
        return { host: fragment.host, scheme: fragment.scheme || 'https', key: fragment.key };
    }
  } catch {}
  const query = new URLSearchParams(location.search);
  const host = query.get('h');
  const key = query.get('k');
  if (host && key) {
    history.replaceState({}, '', location.pathname);
    return { host, scheme: query.get('s') || 'https', key };
  }
  return null;
};
