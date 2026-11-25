# P04 independent review — IN PROGRESS (resume notes)

Fixes committed so far:
- e6d39db (major) expired session's active workout (shark.workout*) carried over to a different user signing in on the same phone.
- 3bbadca (minor) app icon badge not cleared on sign-out / session end.
- 421ddb5 (major) offline sign-out left browser push subscription active -> previous member's pushes kept arriving.

Still to review: API push channel/routes/config/assetlinks, SW + update gating, persistence, admin SW, e2e honesty, gates.
