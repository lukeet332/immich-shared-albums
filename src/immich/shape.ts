/** immich/shape.ts — the displayed shape of a photo, and whether Immich has measured it. See local-immich-api.md. */
/** Immich stores raw sensor dimensions plus an EXIF orientation; the DISPLAYED photo (and the
 *  oriented thumbnail the interceptor serves) has width/height swapped for the quarter-turn
 *  orientations (5–8). Send the DISPLAY dimensions so the mirror stub's aspect matches what Immich
 *  actually renders.
 *
 *  `{}` means Immich has NOT measured this photo yet — which is not the same answer as a photo with
 *  no shape, because it is a reason to wait rather than a reason to give up. */
export function displayDims(exif): { width?: number; height?: number } {
  const w = Number(exif?.exifImageWidth);
  const h = Number(exif?.exifImageHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return {};
  const o = Number(exif?.orientation);
  return o >= 5 && o <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/** Whether a ref built from this exif can carry a usable shape. False is "not measurable yet". */
export const shapeIsKnown = (exif: unknown): boolean => {
  const { width, height } = displayDims(exif);
  return !!width && !!height;
};
