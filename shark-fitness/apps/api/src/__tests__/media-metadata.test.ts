import { describe, expect, it } from 'vitest';
import { sniffMime, stripImageMetadata } from '../lib/media-storage.js';

/** A minimal WebP: RIFF header, VP8X (Exif + XMP flags set), VP8L, EXIF and XMP chunks. */
function chunk(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), size, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webpWithGps(): Uint8Array {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x0c; // Exif + XMP present
  const body = Buffer.concat([
    chunk('VP8X', vp8x),
    chunk('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00])),
    chunk('EXIF', Buffer.from('Exif\0\0GPSLatitude=12.9352;GPSLongitude=77.6245', 'latin1')),
    chunk('XMP ', Buffer.from('<x:xmpmeta>exif:GPSLatitude 12.93</x:xmpmeta>', 'latin1')),
  ]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return new Uint8Array(Buffer.concat([header, body]));
}

describe('stripImageMetadata (review fix)', () => {
  it('drops the EXIF and XMP chunks of a WebP photo and keeps it a valid WebP', () => {
    const input = webpWithGps();
    const out = Buffer.from(stripImageMetadata('image/webp', input));
    expect(out.toString('latin1')).not.toContain('GPSLatitude');
    expect(out.toString('latin1')).toContain('VP8L');
    expect(sniffMime(out)).toBe('image/webp');
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    // VP8X no longer claims Exif or XMP.
    expect(out[12 + 8]! & 0x0c).toBe(0);
  });
});
