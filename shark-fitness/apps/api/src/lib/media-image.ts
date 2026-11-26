/**
 * Image checks and metadata stripping without a native dependency (P05).
 *
 * The member app re-encodes every photo through a canvas before upload, which
 * already drops EXIF (GPS included) and caps the size. This module is the
 * server's own guarantee for anything that did not come through that path:
 *
 * - the type is read from the bytes (magic numbers), never from the file
 *   name or the declared MIME type;
 * - the dimensions are read from the format's own header, and anything wider
 *   or taller than `MAX_IMAGE_SIDE` is refused;
 * - every metadata container is removed — JPEG APPn segments other than
 *   JFIF/Adobe and comments; PNG ancillary text, time, EXIF and physical
 *   chunks; WebP EXIF and XMP chunks (and their VP8X flags) — by copying the
 *   image data verbatim, so nothing is re-compressed and no pixels change.
 *
 * Anything that does not parse cleanly is refused rather than stored.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export const MAX_IMAGE_SIDE = 4096;

export class ImageRejected extends Error {}

export interface CleanImage {
  type: ImageType;
  width: number;
  height: number;
  bytes: Buffer;
  /** Metadata containers that were removed, for the audit trail. */
  removed: string[];
}

export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function cleanImage(input: Buffer): CleanImage {
  const type = sniffImageType(input);
  if (!type) throw new ImageRejected('That file is not a JPEG, PNG or WebP image.');
  let result: Omit<CleanImage, 'type'>;
  try {
    result = type === 'image/jpeg' ? cleanJpeg(input) : type === 'image/png' ? cleanPng(input) : cleanWebp(input);
  } catch (err) {
    // A header too short for the field being read is a damaged file (422),
    // not a server fault (500).
    if (err instanceof ImageRejected) throw err;
    throw new ImageRejected('That image is damaged.');
  }
  if (result.width < 1 || result.height < 1) throw new ImageRejected('That image has no size.');
  if (result.width > MAX_IMAGE_SIDE || result.height > MAX_IMAGE_SIDE) {
    throw new ImageRejected(`That image is ${result.width}×${result.height}. The largest side can be ${MAX_IMAGE_SIDE} pixels.`);
  }
  return { type, ...result };
}

/* ——— JPEG ——————————————————————————————————————————————————— */

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function cleanJpeg(input: Buffer): Omit<CleanImage, 'type'> {
  const out: Buffer[] = [input.subarray(0, 2)];
  const removed: string[] = [];
  let width = 0;
  let height = 0;
  let offset = 2;

  while (offset < input.length) {
    if (input[offset] !== 0xff) throw new ImageRejected('That JPEG is damaged.');
    // Fill bytes before a marker are legal.
    while (input[offset] === 0xff && input[offset + 1] === 0xff) offset += 1;
    const marker = input[offset + 1];
    if (marker === undefined) throw new ImageRejected('That JPEG is damaged.');

    if (marker === 0xd9) {
      out.push(input.subarray(offset, offset + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > input.length) throw new ImageRejected('That JPEG is damaged.');
    const length = input.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > input.length) throw new ImageRejected('That JPEG is damaged.');

    if (SOF_MARKERS.has(marker)) {
      if (length < 7) throw new ImageRejected('That JPEG is damaged.');
      // The first frame header is the image; ignore any later one.
      if (width === 0 && height === 0) {
        height = input.readUInt16BE(offset + 5);
        width = input.readUInt16BE(offset + 7);
      }
    }

    const isApp = marker >= 0xe0 && marker <= 0xef;
    // APP0 only when it is the JFIF header itself (a JFXX extension carries a
    // thumbnail of the original); APP14 is Adobe's colour transform.
    const keepApp = (marker === 0xe0 && input.toString('latin1', offset + 4, offset + 9) === 'JFIF\0') || marker === 0xee;
    if ((isApp && !keepApp) || marker === 0xfe /* comment */) {
      removed.push(marker === 0xfe ? 'COM' : `APP${marker - 0xe0}${marker === 0xe1 ? ' (EXIF/XMP)' : ''}`);
      offset = end;
      continue;
    }

    if (marker === 0xda) {
      // Start of scan: copy the header and the entropy-coded data up to the
      // next real marker, then carry on parsing segments. A progressive JPEG
      // has several scans with tables (and possibly APPn/COM) between them,
      // and anything after the end-of-image marker (a second picture with its
      // own EXIF, a motion-photo video) is dropped, never stored.
      out.push(input.subarray(offset, end));
      let scanEnd = end;
      while (scanEnd < input.length) {
        if (input[scanEnd] !== 0xff) {
          scanEnd += 1;
          continue;
        }
        const next = input[scanEnd + 1];
        if (next === undefined) break;
        // Stuffed zero and restart markers belong to the scan; a run of 0xff
        // is fill before a marker.
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          scanEnd += 2;
          continue;
        }
        if (next === 0xff) {
          scanEnd += 1;
          continue;
        }
        break;
      }
      out.push(input.subarray(end, scanEnd));
      offset = scanEnd;
      continue;
    }
    out.push(input.subarray(offset, end));
    offset = end;
  }

  if (width === 0 || height === 0) throw new ImageRejected('That JPEG has no frame header.');
  return { width, height, bytes: Buffer.concat(out), removed };
}

/* ——— PNG ———————————————————————————————————————————————————— */

/** Everything needed to draw the image the same way; nothing about who took
 *  it, when, where or with what. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'acTL', 'fcTL', 'fdAT']);

function cleanPng(input: Buffer): Omit<CleanImage, 'type'> {
  const out: Buffer[] = [input.subarray(0, 8)];
  const removed: string[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const kind = input.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > input.length) throw new ImageRejected('That PNG is damaged.');
    if (kind === 'IHDR') {
      if (offset !== 8 || length < 13) throw new ImageRejected('That PNG is damaged.');
      width = input.readUInt32BE(offset + 8);
      height = input.readUInt32BE(offset + 12);
    }
    if (PNG_KEEP.has(kind)) out.push(input.subarray(offset, end));
    else removed.push(kind);
    offset = end;
    if (kind === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || width === 0) throw new ImageRejected('That PNG is damaged.');
  return { width, height, bytes: Buffer.concat(out), removed };
}

/* ——— WebP ——————————————————————————————————————————————————— */

const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function cleanWebp(input: Buffer): Omit<CleanImage, 'type'> {
  const declared = input.readUInt32LE(4) + 8;
  if (declared > input.length) throw new ImageRejected('That WebP is damaged.');
  const chunks: Buffer[] = [];
  const removed: string[] = [];
  let width = 0;
  let height = 0;
  let offset = 12;
  let vp8xIndex = -1;

  while (offset + 8 <= declared) {
    const kind = input.toString('latin1', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    const end = offset + 8 + padded;
    if (offset + 8 + size > declared) throw new ImageRejected('That WebP is damaged.');
    const chunk = Buffer.from(input.subarray(offset, Math.min(end, declared)));

    if (kind === 'VP8X') {
      width = 1 + chunk.readUIntLE(12, 3);
      height = 1 + chunk.readUIntLE(15, 3);
      vp8xIndex = chunks.length;
    } else if (kind === 'VP8 ' && width === 0) {
      width = chunk.readUInt16LE(8 + 6) & 0x3fff;
      height = chunk.readUInt16LE(8 + 8) & 0x3fff;
    } else if (kind === 'VP8L' && width === 0) {
      const bits = chunk.readUInt32LE(8 + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }

    // Allowlist, like PNG: only what draws the image is kept.
    if (!WEBP_KEEP.has(kind)) removed.push(kind.trim());
    else chunks.push(chunk.length % 2 === 1 ? Buffer.concat([chunk, Buffer.alloc(1)]) : chunk);
    offset = end;
  }

  if (vp8xIndex >= 0) {
    // Clear the "has EXIF" (0x08) and "has XMP" (0x04) flags we just made untrue.
    const vp8x = chunks[vp8xIndex]!;
    vp8x[8] = vp8x[8]! & ~0x0c;
  }
  if (width === 0) throw new ImageRejected('That WebP has no image data.');
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { width, height, bytes: Buffer.concat([header, body]), removed };
}
