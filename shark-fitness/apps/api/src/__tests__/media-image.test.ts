import { describe, expect, it } from 'vitest';
import { ImageRejected, MAX_IMAGE_SIDE, cleanImage, sniffImageType } from '../lib/media-image.js';
import { JPEG_WITH_GPS, PNG_TOO_WIDE, PNG_WITH_TEXT, WEBP_WITH_EXIF } from './fixtures/images.js';

/** P05: type by magic bytes, every metadata container removed, size capped. */
describe('media image checks', () => {
  it('reads the type from the bytes, not the name', () => {
    expect(sniffImageType(JPEG_WITH_GPS)).toBe('image/jpeg');
    expect(sniffImageType(PNG_WITH_TEXT)).toBe('image/png');
    expect(sniffImageType(WEBP_WITH_EXIF)).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(() => cleanImage(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toThrow(ImageRejected);
  });

  it('strips EXIF, including GPS, from a JPEG without touching the image data', () => {
    expect(JPEG_WITH_GPS.includes(Buffer.from('Exif'))).toBe(true);
    expect(JPEG_WITH_GPS.includes(Buffer.from('TestCam'))).toBe(true);
    const clean = cleanImage(JPEG_WITH_GPS);
    expect(clean).toMatchObject({ type: 'image/jpeg', width: 64, height: 48 });
    expect(clean.bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(clean.bytes.includes(Buffer.from('TestCam'))).toBe(false);
    expect(clean.bytes.includes(Buffer.from('Model X'))).toBe(false);
    expect(clean.removed.some((r) => r.startsWith('APP1'))).toBe(true);
    // Still a whole JPEG: starts with SOI, ends with EOI, and the scan is intact.
    expect([...clean.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...clean.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    const scan = JPEG_WITH_GPS.indexOf(Buffer.from([0xff, 0xda]));
    expect(clean.bytes.includes(JPEG_WITH_GPS.subarray(scan))).toBe(true);
  });

  it('drops anything after the end of the image, such as a second picture with its own EXIF', () => {
    // A multi-picture or motion-photo JPEG: more data, with location, after EOI.
    const trailer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPS-HIDDEN')]);
    const clean = cleanImage(Buffer.concat([JPEG_WITH_GPS, trailer]));
    expect(clean.bytes.includes(Buffer.from('GPS-HIDDEN'))).toBe(false);
    expect([...clean.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it('strips a comment or APPn segment that sits between scans', () => {
    const eoi = JPEG_WITH_GPS.length - 2;
    const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x0e]), Buffer.from('BETWEEN-SCAN')]);
    const tampered = Buffer.concat([JPEG_WITH_GPS.subarray(0, eoi), comment, JPEG_WITH_GPS.subarray(eoi)]);
    const clean = cleanImage(tampered);
    expect(clean.bytes.includes(Buffer.from('BETWEEN-SCAN'))).toBe(false);
    expect(clean.removed).toContain('COM');
  });

  it('refuses a damaged header as a bad image, not a server error', () => {
    // A frame header too short to hold the dimensions.
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00]);
    expect(() => cleanImage(broken)).toThrow(ImageRejected);
  });

  it('strips text chunks from a PNG', () => {
    expect(PNG_WITH_TEXT.includes(Buffer.from('Someone Private'))).toBe(true);
    const clean = cleanImage(PNG_WITH_TEXT);
    expect(clean).toMatchObject({ type: 'image/png', width: 40, height: 30 });
    expect(clean.bytes.includes(Buffer.from('Someone Private'))).toBe(false);
    expect(clean.bytes.includes(Buffer.from('tEXt'))).toBe(false);
  });

  it('strips EXIF from a WebP and keeps the container consistent', () => {
    const clean = cleanImage(WEBP_WITH_EXIF);
    expect(clean).toMatchObject({ type: 'image/webp', width: 64, height: 48 });
    expect(clean.bytes.includes(Buffer.from('EXIF'))).toBe(false);
    expect(clean.bytes.readUInt32LE(4) + 8).toBe(clean.bytes.length);
  });

  it(`refuses an image wider or taller than ${MAX_IMAGE_SIDE} px`, () => {
    expect(() => cleanImage(PNG_TOO_WIDE)).toThrow(/4100×10/);
  });

  it('refuses a truncated image', () => {
    expect(() => cleanImage(PNG_WITH_TEXT.subarray(0, 40))).toThrow(ImageRejected);
  });
});
