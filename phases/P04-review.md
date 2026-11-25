# P04 independent review — IN PROGRESS (resume notes)

Fixes committed so far:
- e6d39db (major) expired session's active workout (shark.workout*) carried over to a different user signing in on the same phone.
- 3bbadca (minor) app icon badge not cleared on sign-out / session end.
- 421ddb5 (major) offline sign-out left browser push subscription active -> previous member's pushes kept arriving.

Still to review: API push channel/routes/config/assetlinks, SW + update gating, persistence, admin SW, e2e honesty, gates.
- (this commit) (major) impersonation session could subscribe to push; delivery ignored impersonationExpiresAt -> operator browser got member pushes for full TTL. Fixed + test.
Gate run 1 (before fix fully loaded): typecheck/lint/build pass; test 1565+1 new (failing pre-fix, passes post-fix, api 914/914).
