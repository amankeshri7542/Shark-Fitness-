# Security baseline

This document describes the Phase 1 production boundaries. It is not a claim of certification or a substitute for a deployment security review.

## Browser sessions

- The raw session token exists only in the `shark_session` HttpOnly cookie.
- Frontend JavaScript does not persist bearer tokens in `localStorage`.
- Unsafe cookie-authenticated requests require a double-submit CSRF token in both the `shark_csrf` cookie and `x-csrf-token` header.
- Unsafe requests with an `Origin` outside `SHARK_ALLOWED_ORIGINS` are rejected.
- Sign-out revokes the exact current session before clearing cookies.
- Bearer authentication is disabled in production unless `SHARK_ALLOW_BEARER_AUTH=true` is deliberately set for a controlled non-browser client.

## Tenant-scoped authentication

Password sign-in requires `tenantSlug`, and user lookup is constrained by both tenant and normalized email. OTP challenges are also created and verified within one tenant. This prevents the same email in another gym from being selected accidentally.

## OTP handling

OTP echo is disabled by default. It is available only outside production when `SHARK_ECHO_OTP=true` is explicitly configured. Production must connect an email/SMS provider before OTP login is enabled for real users.

## Entry passes and door readers

The member app receives a short offline batch of 30-second HMAC-signed pass tokens. It never receives the signing secret and cannot record its own check-in.

A physical reader calls `POST /v1/door/scan` with:

- `x-reader-id`
- `x-reader-key`
- the signed member pass token
- the reader's branch ID

Reader keys are configured in `SHARK_READER_KEYS_JSON` and can be restricted to branch slugs. A successful token window is burned transactionally; a replay is denied even when two readers race.

The current browser component is a token-derived visual transport, not a standards-compliant QR encoder. Before installing physical scanners, replace that view with a reviewed QR/Data Matrix encoder and provision reader credentials through a device-management process.

## Realtime

The browser exchanges its cookie session and CSRF token for a random, one-use WebSocket ticket that expires after 30 seconds. The long-lived session token never appears in the WebSocket URL. Channel authorization is still derived from the server-side session context.

The current realtime hub is single-process. Horizontal production deployment requires a shared event transport such as Durable Objects, Redis Streams, NATS, or an equivalent system.

## Offline writes

IndexedDB entries are keyed and queried by `tenantId:userId`. The processor stops on logout and refuses to continue a queue if the active owner changes during a flush. This prevents one person's offline workout writes from replaying under another person's cookie session on a shared device.

## Required production configuration

- HTTPS only
- exact `SHARK_PUBLIC_ORIGIN` and `SHARK_ALLOWED_ORIGINS`
- unique high-entropy `SHARK_PASS_SECRET`
- unique reader keys in `SHARK_READER_KEYS_JSON`
- `SHARK_ECHO_OTP=false`
- `SHARK_ALLOW_BEARER_AUTH=false`
- persistent encrypted database storage and backups
- external secret manager rather than committed `.env` files
- log redaction and retention controls
- dependency and container scanning
