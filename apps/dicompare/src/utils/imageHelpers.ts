/**
 * Utilities for classifying image URLs by type.
 */

export const isVolumeUrl = (url: string): boolean =>
  /\.(nii|nii\.gz|dcm|ima)$/i.test(url);

export const isFlatImageUrl = (url: string): boolean =>
  /\.(png|jpe?g|gif|svg|webp)$/i.test(url);
