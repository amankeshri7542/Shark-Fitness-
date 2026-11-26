/**
 * Preparing a progress photo on the phone, before it leaves (P05).
 *
 * Drawing the picture onto a canvas and exporting it as a new JPEG drops
 * everything the camera attached — EXIF, GPS, the device model — and caps
 * the size, so a 12-megapixel original becomes a few hundred kilobytes. The
 * server strips metadata again and checks the bytes; this is the first line,
 * not the only one.
 */

/** The longest side we upload. The server accepts up to 4096. */
export const UPLOAD_MAX_SIDE = 2048;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function fitWithin(width: number, height: number, max = UPLOAD_MAX_SIDE): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const scale = max / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export class PhotoPreparationError extends Error {}

export async function prepareUpload(file: File): Promise<Blob> {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    throw new PhotoPreparationError('Choose a JPEG, PNG or WebP photo.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoPreparationError('That photo could not be opened. Try another one.');
  }
  const size = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new PhotoPreparationError('This browser cannot prepare photos. Try another browser.');
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new PhotoPreparationError('That photo could not be prepared. Try another one.');
  return blob;
}
