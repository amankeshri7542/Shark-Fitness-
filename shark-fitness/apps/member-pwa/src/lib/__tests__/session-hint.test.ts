import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasMemberSessionHint, setMemberSessionHint } from '../session-hint';

describe('member session hint', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is absent for a browser that has never signed in', () => {
    expect(hasMemberSessionHint()).toBe(false);
  });

  it('remembers, then forgets, that this browser completed a sign-in', () => {
    setMemberSessionHint(true);
    expect(hasMemberSessionHint()).toBe(true);

    setMemberSessionHint(false);
    expect(hasMemberSessionHint()).toBe(false);
  });

  it('reports no hint when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    // A locked-down browser must fall through to sign-in, not crash boot.
    expect(() => hasMemberSessionHint()).not.toThrow();
    expect(hasMemberSessionHint()).toBe(false);
  });

  it('does not throw when storage cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => setMemberSessionHint(true)).not.toThrow();
  });
});
