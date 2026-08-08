# Shark Fitness
## Enterprise, Compliance, Security and Operational Requirements Document

## Document governance

**Status:** Normative build specification  
**Version:** 2.0  
**Last reviewed:** 6 August 2026  
**Product:** Shark Fitness, multi-tenant gym management and member engagement SaaS  
**Primary surfaces:** Admin Web Dashboard, Member Mobile App, responsive trainer workflows, SaaS Super Admin  

### Requirement language

- **MUST / SHALL:** mandatory for production acceptance.
- **SHOULD:** expected unless an Architecture Decision Record documents a justified exception.
- **MAY:** optional or tenant-configurable.
- A feature is not complete because a screen exists. Completion requires authorization, validation, persistence, error states, auditability where applicable, analytics, tests, and documentation.

### Cross-document precedence

When requirements conflict, agents SHALL apply this order:

1. **Enterprise/Compliance PRD** for law, privacy, security, retention, audit, accessibility, and operational controls.
2. **Engineering/Technical PRD** for architecture, contracts, data integrity, concurrency, deployment, and testing.
3. **Design/UIUX PRD** for interaction, navigation, visual hierarchy, responsive behavior, accessibility implementation, and states.
4. **Product/Functional PRD** for business scope, roles, workflows, product rules, and outcomes.

No agent may silently resolve a contradiction. It must cite the requirement IDs, select the higher-precedence rule, and record the decision in an ADR or product decision log.

### Canonical companion files

- [01_Shark_Fitness_Product_Functional_PRD.md](./01_Shark_Fitness_Product_Functional_PRD.md)
- [02_Shark_Fitness_Engineering_Technical_PRD.md](./02_Shark_Fitness_Engineering_Technical_PRD.md)
- [03_Shark_Fitness_Design_UIUX_PRD.md](./03_Shark_Fitness_Design_UIUX_PRD.md)
- [04_Shark_Fitness_Enterprise_Compliance_PRD.md](./04_Shark_Fitness_Enterprise_Compliance_PRD.md)

### AI-agent execution contract

Every implementation agent SHALL:

1. Read all four PRDs plus current ADRs before changing code.
2. State the requirement IDs being implemented.
3. List assumptions before implementation; assumptions may not override a SHALL requirement.
4. Preserve tenant and branch isolation in every read, write, cache key, event, export, and log.
5. Reuse canonical schemas and enums. Do not create duplicate client-only domain models.
6. Implement loading, empty, error, permission-denied, offline, retry, and destructive-confirmation states where relevant.
7. Add migrations, seed/fixture updates, observability, tests, and documentation in the same change.
8. Run formatting, linting, type checks, unit tests, integration tests, and affected end-to-end tests.
9. Report changed files, verification evidence, unresolved risks, and follow-up work.
10. Never claim compliance, performance, or completion without evidence.


# Purpose

This document defines requirements needed to sell and operate Shark Fitness responsibly for serious gyms and multi-branch customers. It covers compliance readiness, privacy, security, audit, enterprise identity, data lifecycle, edge cases, service reliability, support, vendor management, and architecture trade-offs.

# Compliance posture and legal scope

This is an engineering/product readiness specification, not legal advice or a certification claim. Final applicability, notices, contracts, and retention schedules require qualified counsel for each market and customer.

## Baseline standards and regulations

| Framework | Product posture | Required interpretation |
|---|---|---|
| India DPDP Act 2023 and DPDP Rules 2025 | India-first privacy baseline | Clear notice, lawful purpose/consent where required, rights workflow, reasonable security safeguards, breach process, processor controls, child-data handling, retention minimization |
| GDPR, when offering to people in the EEA or otherwise applicable | Global-ready optional scope | Controller/processor roles, legal basis, data-subject rights, DPIA where high risk, transfer mechanism, processor agreement, privacy by design |
| PCI DSS v4.0.1 | Scope-reduction requirement | Hosted/tokenized payment provider; never store sensitive authentication data; secure webhook and admin environment |
| WCAG 2.2 Level AA | Admin web target and mobile guidance baseline | Accessible auth, focus, input, target size, contrast, error recovery, reduced motion, captions, testing |
| OWASP ASVS | Web/API verification baseline | Target Level 2 controls for authenticated SaaS; risk-based Level 3 controls for highest-risk functions |
| OWASP MASVS | Mobile verification baseline | Storage, crypto, auth, network, platform, code, resilience, and privacy testing |
| ISO/IEC 27001:2022 | ISMS roadmap | Organizational risk management, policies, asset/vendor/incident/access/change controls; no certification claim until audited |
| SOC 2 Trust Services Criteria | Commercial assurance roadmap | Security baseline; add availability, confidentiality, processing integrity, and privacy criteria according to contracts |
| HIPAA | Not assumed | Ordinary gyms are not automatically covered entities; only offer HIPAA/BAA commitments after legal review and compliant vendor/deployment assessment |

## Current India implementation note

The final DPDP Rules were published in November 2025 with phased commencement. The product SHALL maintain a compliance calendar rather than assuming all provisions become enforceable on the same day. Legal counsel owns the final implementation dates and notice wording.

# Enterprise control catalog

## ENT-GOV: Governance and assurance

- **ENT-GOV-001 — SHALL:** Maintain product, security, privacy, retention, incident, access, change, vendor, backup, vulnerability, and acceptable-use policies with owners and review dates.
- **ENT-GOV-002 — SHALL:** Maintain a risk register with likelihood, impact, owner, treatment, due date, evidence, and residual risk.
- **ENT-GOV-003 — SHALL:** Maintain asset, data-flow, subprocessor, secret, integration, and privileged-account inventories.
- **ENT-GOV-004 — SHALL:** Use separation of duties for production access, refunds above threshold, role administration, and tenant support access.
- **ENT-GOV-005 — SHALL:** Run at least annual access review, tabletop incident exercise, disaster-recovery exercise, and vendor review; frequency increases with risk and contract.

## ENT-DATA: Data classification and lifecycle

- **ENT-DATA-001 — SHALL:** Classify data as Public, Internal, Confidential, Sensitive Personal, Financial, Security Secret, or Restricted Health/Progress Media.
- **ENT-DATA-002 — SHALL:** Map every table, object type, event, log, export, backup, and provider payload to a classification and retention policy.
- **ENT-DATA-003 — SHALL:** Collect only fields with documented purpose, visibility, retention, and deletion behavior.
- **ENT-DATA-004 — SHALL:** Encrypt data in transit and at rest through approved providers; use application-level protection for selected highly sensitive fields where justified.
- **ENT-DATA-005 — SHALL:** Implement export, correction, deletion/anonymization, consent withdrawal, and legal-hold workflows with identity verification and evidence.

## ENT-IAM: Identity and privileged access

- **ENT-IAM-001 — SHALL:** Require MFA for platform admins and tenant owners; allow tenant policy to require MFA for staff.
- **ENT-IAM-002 — SHALL:** Support enterprise SSO and SCIM through an optional adapter without changing local role semantics.
- **ENT-IAM-003 — SHALL:** Use least privilege, branch scope, sensitive-field permissions, step-up authentication, session revocation, and device visibility.
- **ENT-IAM-004 — SHALL:** Production infrastructure access uses named accounts, strong MFA, short-lived credentials, approval, and logging.
- **ENT-IAM-005 — SHALL:** Break-glass access is rare, time-limited, reviewed after use, and cannot become a normal support path.

## ENT-SEC: Application and infrastructure security

- **ENT-SEC-001 — SHALL:** Adopt secure SDLC with threat modeling, code review, SAST/dependency/secret scanning, environment separation, and security test gates.
- **ENT-SEC-002 — SHALL:** Validate all input, encode output, protect against injection, SSRF, broken access control, mass assignment, file abuse, and webhook forgery.
- **ENT-SEC-003 — SHALL:** Use rate limits, abuse controls, bot/risk protections, secure headers, TLS, secret rotation, and provider allowlists.
- **ENT-SEC-004 — SHALL:** Test mobile storage, network, deep links, screenshots, clipboard, backup, tampering, and authentication against MASVS controls.
- **ENT-SEC-005 — SHALL:** Commission independent penetration testing before enterprise launch and after material architecture/security changes.

## ENT-PRIV: Privacy and consent

- **ENT-PRIV-001 — SHALL:** Provide concise layered notices describing purpose, data categories, recipients, retention, rights, and contact path.
- **ENT-PRIV-002 — SHALL:** Separate required processing from optional marketing, community, progress-photo, health-integration, AI, and recording consent.
- **ENT-PRIV-003 — SHALL:** Store consent/version/timestamp/source and make withdrawal as easy as grant where legally required.
- **ENT-PRIV-004 — SHALL:** Do not use tenant/member data to train external models without explicit contractual and user-appropriate opt-in.
- **ENT-PRIV-005 — SHALL:** Use privacy-safe defaults: private progress, limited community visibility, no public body metrics, and no unnecessary exact location.

## ENT-CHILD: Minors and dependents

- **ENT-CHILD-001 — SHALL:** Disable self-service minor accounts by default until country/tenant policy, guardian verification, consent, and communication rules are configured.
- **ENT-CHILD-002 — SHALL:** Link guardian and dependent records without exposing the guardian’s unrelated financial or health data.
- **ENT-CHILD-003 — SHALL:** Restrict messaging between staff and minors according to tenant safeguarding policy, including guardian visibility where required.
- **ENT-CHILD-004 — SHALL:** Prevent public community profiles, direct marketing, or AI personalization for minors unless explicitly lawful and approved.
- **ENT-CHILD-005 — SHALL:** Provide age-transition workflow when a dependent becomes legally able to control their account.

## ENT-AUD: Audit, evidence and records

- **ENT-AUD-001 — SHALL:** Audit authentication, MFA, role/permission changes, member sensitive access, financial actions, exports, deletion, support access, integration secrets, and policy changes.
- **ENT-AUD-002 — SHALL:** Audit entries are append-only, timestamped, correlated, actor/resource/action/result scoped, and protected from tenant modification.
- **ENT-AUD-003 — SHALL:** Sensitive values are redacted; audit must prove action without becoming a second PII database.
- **ENT-AUD-004 — SHALL:** Provide tenant-visible audit according to role and platform security audit with longer protected retention.
- **ENT-AUD-005 — SHALL:** Support evidence export for disputes, investigations, and assurance reviews without exposing unrelated tenants.

## ENT-BCP: Availability, incident response and disaster recovery

- **ENT-BCP-001 — SHALL:** Define service tiers, SLOs, RTO/RPO, maintenance windows, support hours, and exclusions in customer contracts.
- **ENT-BCP-002 — SHALL:** Maintain runbooks for auth, database, queue, payment, notification, realtime, storage, streaming, and provider outage.
- **ENT-BCP-003 — SHALL:** Detect, triage, contain, eradicate, recover, communicate, and perform post-incident review with assigned roles.
- **ENT-BCP-004 — SHALL:** Test backup restoration and D1 point-in-time recovery procedures; document provider and application responsibilities.
- **ENT-BCP-005 — SHALL:** Core gym operations degrade safely when AI, analytics, email, video, or third-party integrations fail.

## ENT-VEND: Vendor and subprocessor management

- **ENT-VEND-001 — SHALL:** Perform security/privacy/cost/residency review before approving a provider.
- **ENT-VEND-002 — SHALL:** Maintain contracts, DPA/BAA where applicable, subprocessors, locations, retention, breach terms, and exit/export capability.
- **ENT-VEND-003 — SHALL:** Use provider-specific production/staging separation, least-privilege keys, rotation, webhook verification, and usage alerts.
- **ENT-VEND-004 — SHALL:** Provide customer notice for material subprocessor changes according to contract.
- **ENT-VEND-005 — SHALL:** Maintain replacement/fallback plan for authentication, payments, messaging, AI, and video where practical.

## ENT-CUST: Enterprise customer controls

- **ENT-CUST-001 — SHALL:** Offer configurable password/MFA/session policy, approved domains, SSO, SCIM, role templates, branch scopes, IP restrictions where supported, and audit export.
- **ENT-CUST-002 — SHALL:** Offer tenant-specific retention, export, legal hold, data-region/dedicated deployment only on a priced enterprise plan.
- **ENT-CUST-003 — SHALL:** Provide admin ownership transfer, multiple billing contacts, security contacts, and emergency contacts.
- **ENT-CUST-004 — SHALL:** Provide service status, incident communications, release notes, deprecation policy, and support escalation.
- **ENT-CUST-005 — SHALL:** Provide documented API/webhook limits, sandbox, versioning, and deprecation windows.


# 2. Users, Roles, and Permissions

## 2.1 SaaS platform roles

### Platform Super Admin

Manages gym tenants, plans, feature flags, service health, support access, billing, global templates, abuse controls, and platform-level audit logs.

### Platform Support Agent

Can inspect diagnostic information and, only with explicit time-limited authorization, impersonate a tenant administrator. Every support action is audited.

## 2.2 Gym business roles

### Gym Owner

- Full business access.
- Financials, branches, staff, products, reports, integrations, security, and subscription administration.
- Can create and restrict other roles.

### Regional/Franchise Manager

- Cross-branch operational access.
- Cannot modify platform subscription or ownership unless granted.

### Branch Manager

- Full operational control within assigned branches.
- Limited or aggregated financial permissions based on policy.

### Reception Staff

- Member lookup and onboarding.
- Check-in, manual payment recording, class booking, simple sales, and issue handling.
- No access to sensitive global reports or security settings.

### Trainer/Coach

- Assigned clients, assessments, programs, appointments, check-ins, messaging, habits, and progress.
- Cannot view unrelated financial records unless granted.

### Accountant

- Payments, invoices, refunds, payouts, reconciliation, taxes, and financial exports.
- No workout, private health note, or community moderation access by default.

### Marketing/CRM User

- Leads, segments, campaigns, offers, referrals, automations, and engagement metrics.
- No payment credentials or sensitive assessments.

### Equipment/Facility Staff

- Equipment inventory, maintenance schedules, incidents, and tasks.

### Custom Role

Owner-defined granular permissions. Permission assignment must support resource, action, and scope:

```text
resource: members
operation: read | create | update | delete | export
scope: own | assigned | branch | selected_branches | tenant
```

## 2.3 Member roles/statuses

- Lead
- Trial member
- Active member
- Frozen membership
- Grace-period member
- Expired member
- Suspended member
- Corporate member
- Family/dependent member
- Digital-only member
- Former member

## 2.4 Permission requirements

- Deny by default.
- Server-side enforcement for every API route.
- UI hiding is not authorization.
- Financial export, role changes, refunds, member deletion, and support impersonation require step-up authentication.
- Roles can be scoped to one or more branches.
- Sensitive fields can be protected separately from normal profile access.

---


# 4.21 Multi-Branch and Franchise Management

- Tenant-wide and branch-level configuration.
- Shared or branch-specific membership products.
- Cross-branch access rules.
- Member transfer.
- Central brand templates.
- Branch-level price overrides with permission.
- Consolidated and branch P&L-style operational reports.
- Inter-branch stock transfer.
- Central staff directory.
- Regional roles.
- Franchise royalty/report export.
- Branch benchmark without exposing individual member data unnecessarily.
- Configuration inheritance with explicit override indicators.

# 4.22 Shark Fitness SaaS Super Admin

## Tenant management

- Create, suspend, reactivate, and delete tenant.
- Subscription plan.
- Feature entitlements.
- Usage meters.
- Payment status.
- Trial lifecycle.
- Support contacts.
- Region and data location metadata.

## Platform operations

- Service health.
- Error rates.
- Queue backlog.
- Webhook failures.
- Email/push delivery status.
- Cost by tenant.
- AI usage.
- Video usage.
- Storage usage.
- Abuse/fraud flags.
- Version and migration status.

## Support tools

- Read-only diagnostic view.
- Time-limited audited impersonation.
- Replay failed webhook.
- Requeue notification.
- Export tenant audit package.
- Feature flag override.

# 4.23 Integrations, API, Webhooks, Imports, and Exports

## Payment integrations

- Razorpay.
- Stripe.
- Manual/cash adapter.

## Health integrations

- Apple HealthKit.
- Android Health Connect.
- Wearable integrations through supported APIs later.

## Communication integrations

- Transactional email provider.
- Expo/FCM/APNs push.
- SMS provider adapter.
- WhatsApp Business provider adapter.

## Access integrations

- QR kiosk.
- Generic access-controller webhook/API adapter.
- NFC/wallet pass later.

## Public API

- Versioned REST API.
- OAuth/API keys for approved integrations.
- Fine-grained scopes.
- Rate limits.
- Idempotency keys.
- Cursor pagination.
- Webhook subscriptions.
- Sandbox tenant.

## Webhook events

- member.created
- member.updated
- membership.activated
- membership.expiring
- membership.cancelled
- payment.succeeded
- payment.failed
- attendance.checked_in
- attendance.checked_out
- class.booked
- class.cancelled
- class.waitlist_promoted
- workout.completed
- lead.created
- lead.converted

## Import/export

- CSV templates.
- Column mapping.
- Dry-run validation.
- Error report.
- Chunked processing.
- Rollback for failed imports where feasible.
- Complete tenant export.

---


# 10. Security, Privacy, and Compliance

## 10.1 Security controls

- Tenant isolation at routing, authorization, query, storage path, cache key, and realtime channel.
- Strong RBAC with branch scope.
- Passkeys and 2FA for privileged users.
- Secure, HTTP-only web sessions.
- SecureStore-backed mobile session handling.
- Short-lived signed upload/download URLs.
- Rate limiting per IP, user, tenant, and sensitive operation.
- CSRF protection where cookie sessions are used.
- Strict CORS.
- Content Security Policy.
- Input validation and output encoding.
- File type, size, and malware-scanning integration point.
- Secrets stored in platform secret manager.
- Dependency scanning and lockfile integrity.
- Audit log for sensitive reads and all privileged writes.

## 10.2 Audit log

Record:

- Actor.
- Role.
- Tenant and branch.
- Action.
- Resource and identifier.
- Timestamp.
- Request ID.
- IP/device metadata where permitted.
- Before/after diff for critical settings.
- Reason/approval for refund, write-off, access override, and data export.

Audit logs are append-only from normal application permissions.

## 10.3 Privacy

- Explicit consent for health data, progress photos, marketing, community visibility, and integrations.
- Member can control social profile visibility.
- Sensitive trainer notes have restricted access.
- Data export and deletion workflow.
- Retention periods by record type.
- Private media uses signed URLs.
- Avoid collecting data not needed for product operation.

## 10.4 Payment security

- Never store raw card number, CVV, or UPI credentials.
- Use provider checkout/tokenization.
- Verify webhook signature.
- Store immutable provider event.
- Idempotent processing.
- Separate payment state from membership state.

## 10.5 AI security

- Redact unnecessary personal identifiers before inference.
- Do not train external models on tenant data unless contractually opted in.
- Provider and model allowlist.
- Prompt-injection controls for retrieved content.
- Output validation.
- Human review for high-impact actions.
- Cost and rate limits.

---


# Data classification matrix

| Data example | Classification | Default visibility | Required controls |
|---|---|---|---|
| Public exercise description | Public | all entitled users | integrity, copyright, moderation |
| Internal task and configuration | Internal | authorized tenant staff | RBAC, audit for material changes |
| Member contact and membership | Sensitive Personal | member and permitted staff | encryption, access audit, retention, rights workflow |
| Body measurements, progress photo, injury note | Restricted Health/Progress | member and specifically permitted coach | private default, explicit purpose/consent, signed media, field-level permission |
| Invoice, tax, payment reference | Financial | member/accountant/authorized staff | immutable history, export audit, PCI scope reduction |
| Password hash, session, API key, webhook secret | Security Secret | system/privileged operator only | secret storage, rotation, never log, incident response |
| Audit and support impersonation event | Confidential Security Record | tenant security/platform security | append-only, redaction, protected retention |
| Community post | Tenant Social Content | visibility selected by member/tenant | moderation, report/block, retention/deletion rules |

# Enterprise edge-case and failure-mode catalog

Each item must map to an automated test, runbook, explicit product policy, or documented accepted risk before enterprise launch.

## Identity and tenancy

- Same email belongs to staff in one tenant and member in another.
- Tenant owner loses access to email/phone and requests ownership transfer.
- Support agent tries to extend an expired support session.
- Branch manager URL-manipulates another branch or tenant ID.
- SSO user is deprovisioned while a local session remains active.
- SCIM changes role while user has an in-progress privileged operation.
- A merged member has provider identities and active device sessions.

## Membership, billing and tax

- Payment succeeds but entitlement activation job fails.
- Chargeback occurs after membership expiry.
- Plan upgrade and refund happen concurrently.
- Tax rate changes after invoice issue.
- Member pays cash at one branch for a home-branch invoice.
- Corporate sponsor stops paying but employee wants personal continuation.
- Offline staff records a payment while online staff records the same payment.
- Refund exceeds remaining captured amount or violates provider window.

## Attendance and scheduling

- Rotating QR is captured and replayed from another device.
- Kiosk time is wrong.
- Class capacity is reduced below current bookings.
- A recurring class crosses daylight-saving or timezone rule changes.
- Waitlist promotion occurs while membership expires.
- Member is checked in at two branches under anti-passback policy.
- Facility emergency requires mass checkout and class cancellation.

## Workout, health and AI

- Member reports acute pain during a recommended workout.
- Trainer locks an exercise while AI suggests replacing it.
- Offline device submits stale program edits.
- Health provider retroactively changes step/sleep data.
- AI output includes medical diagnosis or extreme calorie restriction.
- Member has no equipment matching program.
- Progress photo metadata reveals location.
- A deleted exercise remains in historical analytics.

## Community and communication

- Blocked users remain in a group conversation.
- Member withdraws marketing consent after bulk job is scheduled.
- Harassment report involves a staff member who normally handles moderation.
- A minor receives a direct message from staff.
- Leaderboard correction changes a reward already redeemed.
- Notification provider reports delivered but user never receives push.
- Automation loops because its action emits its own trigger.

## Data lifecycle and integration

- Deletion request conflicts with tax retention or legal hold.
- Export job contains data added after snapshot start.
- Import file contains formula injection, malware, invalid encoding, or another tenant’s data.
- Webhook secret rotates while retries for old events remain.
- Provider sends events out of order or reuses identifiers incorrectly.
- Tenant changes data region or requests dedicated deployment.
- Backup contains data that has since been anonymized.

## Operations and scale

- D1 shard approaches size/write limits.
- Queue backlog delays membership expiry jobs.
- Cloud provider region/network incident affects one or more dependencies.
- Tenant causes unusual load or abusive API traffic.
- Live-video usage exceeds budget mid-session.
- A release contains backward-incompatible event schema.
- Observability provider is unavailable during an incident.


# Architecture and product trade-off register

| Decision | Selected approach | Benefit | Cost/risk | Revisit trigger |
|---|---|---|---|---|
| Admin framework | React SPA with Vite | Low hosting cost, clean API boundary, fast authenticated UX | No SSR for public pages | Public marketing/content becomes part of same repository |
| Mobile framework | React Native + Expo | React/TypeScript velocity, AI-agent ecosystem, native performance | Native module compatibility and upgrade discipline | Required capability is blocked or measurable performance fails |
| Backend runtime | Cloudflare Workers TypeScript | $5 baseline, edge scale, no server operations | Runtime limits and less mature relational features | CPU-heavy work, vendor limitation, or enterprise deployment |
| Rust | Selective service/WASM only | Excellent for compute-heavy components | Higher delivery/operations complexity for CRUD | Pose/analytics workload proves value |
| Database | Shared D1 shard with tenant guard | Micro-budget and serverless | No native RLS, D1 limits, complex analytics | Dedicated isolation, size, contention, data residency, advanced BI |
| Realtime | Durable Objects/WebSockets | Ordered coordination and hibernation cost control | Provider-specific architecture | Realtime scale/cost or protocol requirements change |
| Auth | Better Auth self-hosted behind port | Low variable cost and control | Team owns secure operation | Enterprise SSO, SLA, or support burden favors managed identity |
| Enterprise SSO | Optional managed adapter | Faster SAML/SCIM and customer trust | Per-connection cost | Tenant buys enterprise tier |
| Payments | Hosted provider checkout | Reduces PCI scope and fraud burden | Provider dependence and transaction fees | New country/provider or negotiated enterprise gateway |
| AI | Rules-first plus bounded LLM | Safety, explainability, cost predictability | Less magical unrestricted chat | Evaluations prove safe value for broader autonomy |
| Video | Managed streaming | Reliable encoding/delivery | Usage-based cost | Sufficient revenue justifies alternative contract |
| Multi-tenancy | Shared platform plus dedicated enterprise option | Efficient SMB economics | More isolation testing | Contract requires dedicated stack |
| Offline | SQLite outbox for workout-critical actions | Reliable gym experience | Conflict/reconciliation complexity | Device sync burden outweighs value for a module |
| Community | Tenant-bounded by default | Relevance and moderation scope | Less viral discovery | Moderation and privacy model matures |

# Service levels, resilience and support

## Internal SLO targets after commercial launch

- Core authenticated API availability: 99.9% monthly target.
- Check-in and booking p95 excluding external provider: under 500 ms.
- Realtime operational event propagation p95: under 2 seconds under normal conditions.
- Payment webhook durable acknowledgement: under provider timeout; processing observable and retryable.
- Critical queue age alert: defined per job class, with check-in/payment jobs prioritized above analytics.
- RPO target for core transactional data: provider capability and tested restore procedure, documented per environment.
- RTO target: 4 hours for severe core outage as an initial operational objective; enterprise contractual SLA requires funded staffing and architecture review.

These are objectives, not customer promises until monitoring and support capacity prove them.

## Severity model

- **SEV-1:** widespread inability to authenticate, check in, pay, or access tenant data; confirmed data breach; cross-tenant exposure.
- **SEV-2:** major module unavailable or materially incorrect for multiple tenants; high payment/realtime failure.
- **SEV-3:** degraded feature with workaround; single-tenant operational issue.
- **SEV-4:** cosmetic, documentation, or low-impact defect.

## Incident requirements

- Named incident commander, operations lead, communications lead, and scribe.
- Preserve evidence and avoid destructive “fixes” before containment assessment.
- Tenant communication is factual, time-stamped, and does not speculate.
- Security/privacy incidents follow legal notification assessment.
- Post-incident review documents timeline, root causes, contributing controls, customer impact, corrective actions, owners, and verification.

# Enterprise acceptance gates

Before selling an enterprise tier, the organization SHALL have evidence for:

1. Data-flow and subprocessor inventory.
2. Privacy notice, DPA template, rights workflow, retention schedule, and breach runbook reviewed by counsel.
3. MFA and privileged-access controls.
4. Cross-tenant authorization test suite and independent penetration test.
5. Audit-log completeness and export controls.
6. Backup restoration and disaster-recovery exercise.
7. Incident response tabletop exercise.
8. Accessibility audit for critical web and mobile flows.
9. Payment architecture review and applicable PCI self-assessment with provider guidance.
10. Vendor/security reviews for auth, cloud, payments, communication, AI, analytics, and video.
11. SSO/SCIM adapter tests if sold.
12. Customer-facing SLA/support commitments matched by staffing and monitoring.
13. Usage metering and hard cost controls.
14. Deletion/anonymization/legal-hold test evidence.
15. Security and privacy training for personnel with production or support access.

# 11. Non-Functional Requirements

## 11.1 Performance targets

### Admin web

- Initial authenticated shell usable in under 2.5 seconds on a typical broadband connection and modern mid-range laptop.
- Route transitions under 200 ms when data is cached.
- Table filtering/sorting remains responsive at normal page sizes.
- Avoid shipping large chart/grid libraries on routes that do not use them.

### Mobile

- Cold start target under 2.5 seconds on representative mid-range Android hardware.
- Primary navigation maintains 60 FPS under normal load.
- Set logging responds within 100 ms locally.
- Check-in success response normally visible within 2 seconds.
- Active workout survives app backgrounding and process restart.

### API

- p50 under 100 ms for cached/simple edge operations.
- p95 under 500 ms for normal CRUD excluding third-party providers.
- p99 errors investigated with request correlation.

## 11.2 Availability and resilience

- Core target: 99.9% monthly availability after commercial launch.
- Graceful degradation when analytics, AI, email, or video provider is unavailable.
- Payment webhooks retry safely.
- Queue dead-letter handling.
- D1 point-in-time recovery runbook.
- R2 lifecycle and backup/export strategy.
- Disaster recovery exercise before broad launch.

## 11.3 Scalability

- Stateless API workers.
- Tenant database routing.
- Horizontal realtime rooms.
- Async report generation.
- Paginated APIs.
- No unbounded list endpoints.
- Aggregate tables for expensive dashboards.
- Feature flags for staged rollout.

## 11.4 Observability

- Structured logs.
- Request ID propagated through API, queue, webhook, and notification.
- Error monitoring.
- Latency and failure metrics by route.
- D1 rows read/written monitoring.
- Queue depth and age.
- Webhook delivery status.
- Notification delivery outcomes.
- Tenant usage and cost estimates.
- Synthetic check-in, booking, and payment-webhook tests.

## 11.5 Localization

- Internationalization-ready from first UI.
- English first.
- Configurable currency, time format, date format, unit system, timezone, tax labels, and phone formatting.
- Translatable notification templates.
- Right-to-left support not required initially but must not be structurally impossible.

---

# 14. Quality and Test Strategy

## 14.1 Test layers

- Domain unit tests.
- Schema/contract tests.
- API integration tests.
- Database migration tests.
- Payment webhook fixtures.
- Component tests.
- Web end-to-end tests.
- Mobile device-flow tests.
- Realtime concurrency tests.
- Offline synchronization tests.
- Accessibility tests.
- Visual regression tests for design-system components.
- Load tests for check-in, class booking, and dashboards.
- Security tests and dependency scans.

## 14.2 Mandatory critical test scenarios

- Cross-tenant access attempt.
- Branch permission boundary.
- Duplicate payment webhook.
- Concurrent last-seat booking.
- Dynamic QR replay.
- Offline workout retry.
- Membership freeze and renewal edge cases.
- Refund with partial membership consumption.
- Timezone/DST recurring schedule.
- Member deletion/anonymization.
- Notification opt-out.
- Large import with invalid rows.
- Realtime reconnect and missed-event replay.

## 14.3 Test data

Provide deterministic factories for:

- Tenant and branches.
- Every role.
- Lead stages.
- Member statuses.
- Membership lifecycle.
- Payment states.
- Full and waitlisted class.
- Offline workout.
- At-risk member.
- Multi-branch owner.

No production personal data may be copied into development environments.

---

# 18. Commercial Launch Checklist

## Product

- Tenant onboarding tested.
- All roles and permissions verified.
- Member join, payment, check-in, booking, workout, and renewal flows verified.
- Support and feedback available.
- Empty states and first-use guidance complete.

## Operations

- Production environments separated.
- Backups and restore tested.
- Monitoring and alerts active.
- Webhook replay tools ready.
- Incident ownership defined.
- Status communication process defined.

## Security

- Threat model reviewed.
- 2FA enforced for privileged roles.
- Secrets rotated.
- Audit logs protected.
- Dependency and container/runtime scan clean.
- Data export/deletion tested.

## Finance

- Payment settlement reconciliation tested.
- Tax/invoice settings reviewed by target-market accountant.
- Refund and chargeback process documented.
- Usage cost alerts configured.

## Mobile

- Real device test matrix complete.
- Offline workout tested.
- Push deep links tested.
- Permission prompts have clear rationale.
- Privacy labels and store disclosures prepared.
- Crash-free and startup metrics monitored.

## Customer success

- Admin onboarding guide.
- Member onboarding content.
- Import templates.
- Support escalation.
- Training sessions.
- Feedback cadence.

---


# Verified standards and source baseline

The following official sources were checked for this revision:

- India MeitY: [Digital Personal Data Protection Act, 2023](https://www.meity.gov.in/content/digital-personal-data-protection-act-2023) and [Digital Personal Data Protection Rules, 2025](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa).
- European Union EUR-Lex: [Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) (GDPR).
- PCI Security Standards Council: [PCI DSS v4.0.1 document library](https://www.pcisecuritystandards.org/document_library/).
- W3C: [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [mobile application guidance](https://www.w3.org/TR/wcag2mobile-22/).
- OWASP: [ASVS](https://owasp.org/www-project-application-security-verification-standard/) and [MASVS](https://mas.owasp.org/MASVS/).
- ISO: [ISO/IEC 27001:2022](https://www.iso.org/standard/27001).
- AICPA: [Trust Services Criteria](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022) used for SOC 2 examinations.
- US HHS: [HIPAA covered entities and business associates](https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html).

# Cross-document review report

## Review method

The four PRDs were reviewed for scope coverage, contradictory technology choices, requirement precedence, missing states, enterprise claims, budget realism, edge cases, and AI-agent ambiguity.

## Resolved contradictions

1. **Admin web:** standardized on React + Vite SPA for the authenticated dashboard; Next.js is reserved for a future public marketing site.
2. **Backend:** standardized on Cloudflare Workers + Hono + TypeScript for the primary API; Rust is optional for proven compute-heavy services.
3. **Authentication:** standardized on Better Auth behind an identity abstraction for the low-cost baseline; managed enterprise SSO/SCIM is an optional paid adapter.
4. **D1 tenancy:** removed the assumption that the Worker can dynamically bind one D1 database per tenant. Baseline is a shared business shard with mandatory tenant guards; dedicated deployments are explicit enterprise work.
5. **$15 budget:** clarified as low-usage fixed infrastructure. Video, SMS/WhatsApp, high-volume email, AI overage, payment fees, app-store fees, and enterprise identity are metered or tenant-funded.
6. **AI:** standardized on rules-first recommendations with bounded generative explanation; no autonomous medical or unsafe coaching.
7. **Compliance:** wording changed from “compliant/certified” to “control-ready” unless external legal/audit evidence exists.

## Coverage confirmation

- Product surfaces and every major gym domain are represented.
- Admin, member, trainer, owner, accountant, marketing, facility, platform, and support roles are defined.
- Happy paths, offline behavior, concurrency, provider failure, data lifecycle, accessibility, security, and cost controls are covered.
- Design specifications include states, responsive behavior, accessibility, motion, content, and screen-level contracts.
- Engineering includes data, API, events, sync, providers, CI/CD, tests, cost, migrations, and phase prompts.
- Enterprise includes privacy, security, audit, minors, vendor management, DR, SSO/SCIM, legal hold, edge cases, and trade-offs.

## Assumptions deliberately fixed to avoid agent hallucination

- India-first launch, global-ready adapters.
- English-first localization with architecture prepared for additional languages.
- Razorpay is the default India payment adapter; Stripe is the global adapter.
- Fitness, progress, nutrition, and recovery data are wellness/coaching data, not medical diagnosis.
- Minor accounts are disabled by default until guardian and local-law policy is configured.
- Member progress and community visibility are private by default.
- Live streaming, SMS/WhatsApp, and broad AI usage require quota or paid add-on.
- Enterprise dedicated infrastructure and contractual SLA are separate priced offerings.

## Remaining owner decisions that do not block engineering foundations

- Final Shark Fitness brand palette, typography license, and logo system.
- Commercial packages, prices, included quotas, and overage margins.
- Exact launch countries and local tax/invoice wording.
- Whether community is enabled by default for each tenant.
- Which access-control hardware vendors are first supported.
- Whether nutrition is included in base plans or a coaching add-on.

Until decided, agents SHALL use feature flags and configuration, not hard-coded assumptions.
