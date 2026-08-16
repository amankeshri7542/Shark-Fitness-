const MEMBER_SESSION_HINT_KEY = 'shark.member.has-session';

/**
 * A non-sensitive browser hint that says this browser previously completed a
 * member sign-in. The real credential remains the HttpOnly session cookie.
 *
 * We need this because JavaScript cannot inspect an HttpOnly cookie. Without a
 * hint, every fresh visitor has to call /v1/me before we know whether to show
 * sign-in. On a sleeping demo backend that turns a cached PWA shell into an
 * indefinite splash screen.
 */
export function hasMemberSessionHint(): boolean {
  try {
    return localStorage.getItem(MEMBER_SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMemberSessionHint(present: boolean): void {
  try {
    if (present) localStorage.setItem(MEMBER_SESSION_HINT_KEY, '1');
    else localStorage.removeItem(MEMBER_SESSION_HINT_KEY);
  } catch {
    /* Storage can be unavailable in private/locked-down browsers. */
  }
}
