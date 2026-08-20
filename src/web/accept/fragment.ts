/**
 * Where the invite details come from.
 *
 * The banner puts them in the URL fragment so they never reach a server log — neither the
 * origin's nor ours. The query-string form is the fallback for anything that strips fragments;
 * it is rewritten out of the address bar immediately for the same reason.
 */
export type Invite = { host: string; scheme: string; key: string };

export const readInvite = (): Invite | null => {
  try {
    if (location.hash.length > 1) {
      const f = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      if (f?.host && f?.key) return { host: f.host, scheme: f.scheme || 'https', key: f.key };
    }
  } catch {
    // fall through to the query form
  }
  const qp = new URLSearchParams(location.search);
  const host = qp.get('h');
  const key = qp.get('k');
  if (host && key) {
    history.replaceState({}, '', location.pathname);
    return { host, scheme: qp.get('s') || 'https', key };
  }
  return null;
};
