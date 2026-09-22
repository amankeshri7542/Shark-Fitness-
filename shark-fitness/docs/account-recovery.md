# Owner-supervised existing-account recovery

This local workflow restores a password for an eligible existing member or ordinary staff account. It does not send email/SMS, verify an identity document automatically, change a role, enable a disabled account, or grant membership access. First-time activation remains a separate workflow for accounts without a password. Owner and platform accounts are excluded; their recovery requires a separately approved operator procedure.

## Private human handoff

The owner signs in directly to the appropriate gym and branch. On the member or staff profile, use **Existing account recovery** only after verifying the person in person against existing gym records. Do not use possession of an email address, phone number, or a request from reception as sufficient evidence. Do not put identity-document numbers, passwords, or recovery links in reasons, support tickets, screenshots, shared documents, or logs.

1. Check the intended person's existing account and employment/member record. New accounts use **Account activation**. Disabled, deleted, legal-hold and ineligible accounts must follow their own review process.
2. Record a brief recovery reason and explicitly acknowledge the in-person identity check. The owner privately re-enters their current password and selects **Create recovery link**.
3. Privately hand the link to the verified recipient; it expires after 15 minutes. Hide it on the owner's screen afterward. Creating another link invalidates all earlier handoffs for that account. Do not change the person's email or phone merely to recover access.
4. On the recipient's own device/profile, open the link. The recipient alone enters a new password of at least 12 characters and selects **Set new password**. The link is one-use. A changed login identity, password, role, disabled state, employment state or owner authority causes a refusal instead of an account takeover.
5. Completion returns to normal sign-in and revokes all previous sessions and realtime connections. Sign in using the existing gym code/email and the new password. Verify the same account, role, membership status, balance and history. A member whose membership expired still has expired membership.
6. Check audit events `account.recovery_issued` and `account.recovery_completed`. The issuance records the owner, reason and acknowledged verification; neither event stores the password or raw token. If a response is lost, do not assume the recovery failed: try normal sign-in with the chosen password first. A consumed link cannot be reused.

## Permitted technical evidence and pending acceptance

Programmatic integration tests use separate synthetic accounts and check authorization, invalid input, tenant/branch scope, ineligible states, replacement/expiry/single use, stale identity, session/ticket revocation, immediate websocket closure, and unchanged roles/member records. UI tests exercise both recovery forms independently of first-time activation.

Actual browser password submissions remain a **human-only handoff** because automatic approval review previously denied private fresh-account password submission. Do not bypass that denial with another browser mechanism. The human must privately perform both the owner's fresh-password authorization and recipient's new-password submission; automation may inspect the resulting nonsecret UI afterward. Physical-phone acceptance and an uncoached owner/reception run remain pending. Programmatic tests do not establish either acceptance gate or launch a real-member pilot.
