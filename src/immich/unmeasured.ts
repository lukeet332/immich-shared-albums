/** immich/unmeasured.ts — the rig's list of photos to treat as not yet measured by Immich. See local-immich-api.md. */
const hidden = new Set<string>();

/** Whether a rig has hidden this photo's dimensions, so the sidecar behaves exactly as it does in
 *  the window between an upload and Immich's metadata job. Empty in every real install. */
export const isHiddenAsUnmeasured = (assetId: string) => hidden.has(assetId);

/** Hide or reveal one photo's dimensions, by asset id on the server being asked. Rig-only. */
export const hideAsUnmeasured = (assetId: string, hide: boolean) => {
  if (hide) hidden.add(assetId);
  else hidden.delete(assetId);
};
