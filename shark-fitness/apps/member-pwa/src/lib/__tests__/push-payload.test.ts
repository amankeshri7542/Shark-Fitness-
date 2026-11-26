import { describe, expect, it } from 'vitest';
import { deepLinkUrl, isSafeAppPath, parsePushPayload } from '../push-payload';

const ORIGIN = 'https://gym.example';

describe('parsePushPayload', () => {
  it('reads the three fields the API sends', () => {
    expect(parsePushPayload(JSON.stringify({ title: 'Class in 2 hours', body: 'HIIT at 18:30', path: '/book', tag: 'cls_1' }))).toEqual({
      title: 'Class in 2 hours',
      body: 'HIIT at 18:30',
      path: '/book',
      tag: 'cls_1',
    });
  });

  it('falls back to a generic notification that opens the inbox when the payload is not usable', () => {
    expect(parsePushPayload('not json')).toEqual({
      title: 'Shark Fitness',
      body: 'You have a new notification.',
      path: '/notifications',
    });
    expect(parsePushPayload(null).path).toBe('/notifications');
  });

  it('refuses a path that would leave the app', () => {
    for (const path of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', '/\\evil.example', 'book']) {
      expect(parsePushPayload({ title: 't', body: 'b', path }).path).toBe('/notifications');
    }
  });

  it('caps oversized text', () => {
    const payload = parsePushPayload({ title: 'x'.repeat(500), body: 'y'.repeat(500), path: '/' });
    expect(payload.title).toHaveLength(120);
    expect(payload.body).toHaveLength(240);
  });
});

describe('deepLinkUrl', () => {
  it('opens the exact in-app route under /app/', () => {
    expect(deepLinkUrl('/messages/cnv_1', ORIGIN)).toBe('https://gym.example/app/messages/cnv_1');
    expect(deepLinkUrl('/book?session=s1', ORIGIN)).toBe('https://gym.example/app/book?session=s1');
    expect(deepLinkUrl('/app/billing', ORIGIN)).toBe('https://gym.example/app/billing');
  });

  it('never leaves this origin', () => {
    expect(deepLinkUrl('//evil.example/x', ORIGIN)).toBe('https://gym.example/app/notifications');
    expect(deepLinkUrl(undefined, ORIGIN)).toBe('https://gym.example/app/notifications');
    expect(isSafeAppPath('/ok')).toBe(true);
    expect(isSafeAppPath('/a\u0000b')).toBe(false);
  });
});
