# ADR-004: TOTP two-step sign-in now, passkeys later

- **Status:** Accepted
- **Date:** 2026-11-25
- **Decision owners:** Shark Fitness engineering (P06), recorded without the client's input while he was travelling
- **Related:** PRD 04 ENT-IAM-001/003 and §10.1 ("Passkeys and 2FA for privileged users"); PRD 02 "Authentication" and "Identity rules"; [SECURITY.md](SECURITY.md)

## Context

PRD 04 makes multi-factor sign-in mandatory for platform admins and tenant
owners and lets a gym require it for all staff. PRD 02 lists passkeys and
two-factor authentication among the authentication features. Neither existed:
staff signed in with a password alone, including the owner account that can
refund money, export every member and change who works there.

The product is a single Node process with a cookie session (ADR-001), a staff
console used on shared front-desk machines and personal laptops, and a member
PWA. Gym owners in the first market (India) mostly carry Android phones;
front-desk staff often share a desktop.

## Decision

1. **TOTP (RFC 6238) is the second factor**, implemented with the `otpauth`
   library — SHA-1, 6 digits, 30-second period, the parameters every
   authenticator app supports. No TOTP code is hand-written.
2. **Mandatory** for `owner`, `regional_manager`, `platform_admin` and
   `platform_support`; **optional per gym** for all other staff
   (`requireMfaForStaff`); **never** for members.
3. **Enforced at sign-in by a partial session.** After the password, a session
   that owes a code or an enrolment can reach only the MFA routes and answers
   `401 MFA_REQUIRED` everywhere else. Completing it replaces the token.
4. **Recovery:** ten single-use recovery codes (hashed). A lost device without
   codes is reset by the gym owner for staff, and by platform support for an
   owner; both need a reason and a step-up and are audited in the gym's log.
5. **Secrets at rest** are AES-256-GCM under `SHARK_MFA_ENCRYPTION_KEY`
   (required in production), with a per-purpose HKDF key and the user id as
   additional authenticated data.
6. **Replay and guessing:** each code is accepted once; five wrong codes lock
   the factor for 15 minutes; the endpoint is rate-limited per IP.
7. The same re-check (password plus TOTP) is the **step-up** for high-risk
   actions (SECURITY.md "Step-up re-authentication").

## Why not passkeys first

Passkeys (WebAuthn) are the stronger factor — phishing-resistant, no shared
secret on the server — and remain the target. They are deferred because:

- **Recovery is the hard part, and it needs product decisions we cannot take
  without the client.** A passkey lost with a phone, or a desk PC whose
  platform authenticator belongs to whoever set it up, needs a recovery and
  device-management story (multiple passkeys per person, which device is
  "the desk", what reception does at 6 a.m. when the owner is unreachable).
  TOTP plus recovery codes plus owner/support reset is a well-understood
  story that gyms can run today.
- **Shared front-desk machines.** Platform passkeys are bound to an OS
  account; many desks share one OS login. Roaming authenticators (security
  keys) would have to be bought and issued per person.
- **Verification depth.** A correct WebAuthn rollout means a vetted library
  (attestation, counters, user verification, origin/RP-ID checks under
  `/admin/` and `/app/` on one origin), browser E2E with virtual
  authenticators, and support for the member app later. That is a phase of its
  own, not a corner of this one.
- **The requirement is met either way.** ENT-IAM-001 asks for MFA; TOTP
  satisfies it now, and the partial-session and step-up machinery built here is
  factor-agnostic, so passkeys slot in as another way to complete them.

## Consequences

- Owners on the hosted demo meet the enrolment gate on first sign-in and need
  an authenticator app. Platform support can reset them (documented in
  SECURITY.md).
- `SHARK_MFA_ENCRYPTION_KEY` is now key material that must be kept with the
  backup key; losing it forces every staff member to re-enrol.
- TOTP remains phishable in real time (a fake console can relay a code within
  its 30-second window). Step-up limits what a relayed session can do without
  a second relay; passkeys remove the class.
- Automated tests and scripts that sign in as an owner must complete the
  challenge (helpers in the API tests, `e2e/support/totp.ts`,
  `scripts/lib/console-session.mjs`).

## Revisit when

- A gym asks for passkeys or security keys, or a customer security review
  requires phishing-resistant MFA for owners (ENT-IAM-002 SSO customers will
  bring their own IdP MFA instead).
- Members are offered sign-in protection beyond OTP/password.
- A real phishing or relay incident against a staff account.
