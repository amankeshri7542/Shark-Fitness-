import { z } from 'zod';
import { TicketPriority, TicketState } from '../enums.js';
import { Id, IsoDateTime } from './identity.js';

/* ============================================================================
   Support, feedback and retention — PF-SUP-001…006.

   These are the canonical wire shapes. The console reads them directly and
   keeps no parallel interfaces: Phase 7 shipped a client-side fork of a server
   shape that typechecked perfectly while it drifted, and the member picker
   rendered blank names for a fortnight because of it.

   Two conventions carry through.

   Timestamps are ISO-8601 UTC on the wire even though the tables store epoch
   milliseconds, matching every other module.

   Anything a role may not see is `null` with the reason named alongside it,
   never a zero, an empty string or a silently dropped field. In this module
   that mostly means anonymity: an anonymous report has no member because none
   was ever recorded, which is a different fact from "you may not see who".
   ========================================================================= */

/* — Enums ——————————————————————————————————————————————————— */

/* `TicketState` and `TicketPriority` are *not* redefined here. `enums.ts` has
   carried them since Phase 1 — five states, including the distinction between
   waiting on the member and waiting on us — and a second, narrower copy in this
   file would be exactly the client-side fork of a canonical shape that
   `schemas/pos.ts` exists to warn about. Import them from the barrel. */

/** Matches the categories the member app already offers. */
export const TicketCategory = z.enum([
  'billing',
  'membership',
  'facility',
  'class',
  'app',
  'complaint',
  'other',
]);
export type TicketCategory = z.infer<typeof TicketCategory>;

export const SlaState = z.enum(['on_track', 'due_soon', 'breached', 'met', 'none']);
export type SlaState = z.infer<typeof SlaState>;

/** Every kind of event the immutable ticket timeline records. */
export const TicketEventKind = z.enum([
  'opened',
  'assigned',
  'priority_changed',
  'state_changed',
  'replied',
  'internal_note',
  'escalated',
  'resolved',
  'reopened',
  'closed',
]);
export type TicketEventKind = z.infer<typeof TicketEventKind>;

export const FeedbackKind = z.enum(['nps', 'csat', 'class', 'trainer', 'facility', 'cancellation']);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const InterventionAction = z.enum([
  'call',
  'coach_checkin',
  'offer_review',
  'visit_invite',
  'no_action',
]);
export type InterventionAction = z.infer<typeof InterventionAction>;

export const InterventionState = z.enum(['open', 'done', 'dismissed']);
export type InterventionState = z.infer<typeof InterventionState>;

export const InterventionOutcome = z.enum(['retained', 'churned', 'no_contact', 'false_positive']);
export type InterventionOutcome = z.infer<typeof InterventionOutcome>;

export const RiskBand = z.enum(['low', 'watch', 'high']);
export type RiskBand = z.infer<typeof RiskBand>;

/* — SLA ————————————————————————————————————————————————————— */

/**
 * The SLA verdict. Computed on every read from `openedAt`, the promise made at
 * the time, and the first reply — never stored, so it cannot drift away from
 * the timestamps that produced it.
 */
export const TicketSla = z.object({
  state: SlaState,
  /** Already written for a human: "Reply 3h overdue". */
  label: z.string(),
  /** Negative once past the deadline. Null when nothing was promised. */
  dueInMinutes: z.number().int().nullable(),
  breached: z.boolean(),
  dueAt: IsoDateTime.nullable(),
  /** Minutes of *open* time promised — the clock pauses when the branch shuts. */
  responseMinutes: z.number().int().nullable(),
  firstResponseAt: IsoDateTime.nullable(),
});
export type TicketSla = z.infer<typeof TicketSla>;

/* — Tickets (PF-SUP-001) ————————————————————————————————————— */

export const TicketSummary = z.object({
  id: Id,
  reference: z.string(),
  branchId: Id.nullable(),
  branchName: z.string().nullable(),
  /** Null on an anonymous report — nothing was recorded, nothing is hidden. */
  memberId: Id.nullable(),
  memberName: z.string().nullable(),
  /** True when the member record is gone or deactivated. The ticket survives
   *  it (PF-SUP edge case: a ticket stays open after membership deletion). */
  memberInactive: z.boolean(),
  category: TicketCategory,
  subject: z.string(),
  priority: TicketPriority,
  state: TicketState,
  assigneeId: Id.nullable(),
  assigneeName: z.string().nullable(),
  anonymous: z.boolean(),
  escalated: z.boolean(),
  vulnerabilityFlag: z.boolean(),
  /** Safety categories the member's own words tripped. Drives the plain-register
   *  handling and blocks every automated outreach path. */
  safetyCategories: z.array(z.string()),
  reopenCount: z.number().int(),
  sla: TicketSla,
  openedAt: IsoDateTime,
  lastUpdateAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
  closedAt: IsoDateTime.nullable(),
});
export type TicketSummary = z.infer<typeof TicketSummary>;

/** One entry in the append-only timeline (PF-SUP-006). */
export const TicketEvent = z.object({
  id: Id,
  kind: TicketEventKind,
  actorName: z.string(),
  actorRole: z.string(),
  summary: z.string(),
  /** Set when this event is a member-visible reply, so the timeline and the
   *  conversation are provably the same history. */
  messageId: Id.nullable(),
  at: IsoDateTime,
});
export type TicketEvent = z.infer<typeof TicketEvent>;

/** A message in the member-facing conversation this ticket owns. */
export const TicketMessage = z.object({
  id: Id,
  senderName: z.string(),
  senderRole: z.string(),
  /** True when the sender is the member rather than the desk. */
  fromMember: z.boolean(),
  body: z.string(),
  attachments: z.array(z.object({ name: z.string(), url: z.string(), sizeBytes: z.number().int() })),
  safetyFlagged: z.boolean(),
  readAt: IsoDateTime.nullable(),
  at: IsoDateTime,
});
export type TicketMessage = z.infer<typeof TicketMessage>;

/**
 * What the desk needs to know about the person in front of them, without
 * opening another screen. Deliberately small: balance, membership and last
 * visit answer most support questions; anything more belongs on Member 360.
 */
export const TicketMemberContext = z.object({
  memberId: Id,
  memberNo: z.string(),
  name: z.string(),
  lifecycle: z.string(),
  homeBranchName: z.string(),
  joinedOn: z.string(),
  lastVisitAt: IsoDateTime.nullable(),
  membershipState: z.string().nullable(),
  membershipProduct: z.string().nullable(),
  membershipEndsOn: z.string().nullable(),
  /** Null without `billing.view`. Withheld, not zeroed. */
  balanceMinor: z.number().int().nullable(),
  openTickets: z.number().int(),
  riskScore: z.number().int().nullable(),
  riskBand: RiskBand.nullable(),
  /** True when the member row is soft-deleted or their account is closed. */
  inactive: z.boolean(),
});
export type TicketMemberContext = z.infer<typeof TicketMemberContext>;

export const TicketDetail = z.object({
  ticket: TicketSummary,
  /** Null on an anonymous report: there is no conversation, because there is
   *  nobody to reply to without undoing the anonymity that was promised. */
  conversationId: Id.nullable(),
  messages: z.array(TicketMessage),
  timeline: z.array(TicketEvent),
  member: TicketMemberContext.nullable(),
  /** Why a reply cannot be sent right now, if it cannot. Null means it can. */
  replyBlockedReason: z.string().nullable(),
  resolution: z.string().nullable(),
  escalation: z
    .object({ at: IsoDateTime, by: z.string(), reason: z.string() })
    .nullable(),
});
export type TicketDetail = z.infer<typeof TicketDetail>;

export const TicketQueue = z.object({
  items: z.array(TicketSummary),
  /** Counts for the whole permitted scope, not just the filtered page — a
   *  breach you filtered out is still a breach. */
  counts: z.object({
    open: z.number().int(),
    /** Work sitting in the building. */
    pendingStaff: z.number().int(),
    /** Somebody else's turn — deliberately counted apart from the above. */
    pendingMember: z.number().int(),
    resolved: z.number().int(),
    closed: z.number().int(),
    breached: z.number().int(),
    unassigned: z.number().int(),
    escalated: z.number().int(),
    mine: z.number().int(),
  }),
  assignees: z.array(z.object({ id: Id, name: z.string() })),
  /** The reply promise per category, so the UI states it before a ticket exists. */
  categories: z.array(z.object({ value: TicketCategory, responseMinutes: z.number().int() })),
  asOf: IsoDateTime,
});
export type TicketQueue = z.infer<typeof TicketQueue>;

/* — Feedback (PF-SUP-002) ———————————————————————————————————— */

export const FeedbackEntry = z.object({
  id: Id,
  kind: FeedbackKind,
  score: z.number().int().nullable(),
  comment: z.string(),
  anonymous: z.boolean(),
  branchId: Id.nullable(),
  branchName: z.string().nullable(),
  memberId: Id.nullable(),
  memberName: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectLabel: z.string().nullable(),
  ticketId: Id.nullable(),
  ticketReference: z.string().nullable(),
  at: IsoDateTime,
});
export type FeedbackEntry = z.infer<typeof FeedbackEntry>;

export const FeedbackSummary = z.object({
  items: z.array(FeedbackEntry),
  /** Promoters minus detractors over responses. Null under the reporting
   *  floor — an NPS of −100 from one answer is true and useless. */
  nps: z.object({
    responses: z.number().int(),
    promoters: z.number().int(),
    passives: z.number().int(),
    detractors: z.number().int(),
    score: z.number().int().nullable(),
  }),
  csat: z.object({
    responses: z.number().int(),
    average: z.number().nullable(),
    satisfiedPct: z.number().int().nullable(),
  }),
  /** Cancellation reasons, most common first. The one report that changes what
   *  a gym does next quarter. */
  cancellationReasons: z.array(z.object({ reason: z.string(), count: z.number().int() })),
  /** Null under the floor, like every other derived rate here. */
  classRating: z.number().nullable(),
  trainerRating: z.number().nullable(),
  /** How many responses were given anonymously — the number that says whether
   *  the anonymity option is doing anything. */
  anonymousCount: z.number().int(),
  asOf: IsoDateTime,
});
export type FeedbackSummary = z.infer<typeof FeedbackSummary>;

/* — Retention (PF-SUP-003, PF-SUP-004) ——————————————————————— */

export const RiskReason = z.object({
  code: z.string(),
  label: z.string(),
  points: z.number().int(),
});
export type RiskReason = z.infer<typeof RiskReason>;

export const AtRiskMember = z.object({
  memberId: Id,
  memberNo: z.string(),
  name: z.string(),
  branchId: Id,
  branchName: z.string(),
  score: z.number().int(),
  band: RiskBand,
  /** Every contribution, named and weighted. PF-SUP-003 asks for explainable,
   *  which means the member can be shown why, not just how much. */
  reasons: z.array(RiskReason),
  recommendedAction: z.string(),
  /** Set when the score is deliberately not being reported — a new joiner, or
   *  a window the branch spent shut. Never a silent zero. */
  suppressed: z.string().nullable(),
  lastVisitAt: IsoDateTime.nullable(),
  membershipEndsOn: z.string().nullable(),
  /** An open intervention already exists, so nobody calls them twice. */
  openInterventionId: Id.nullable(),
  /** PF-SUP-005: whether an automated message may be sent, and why not. */
  outreach: z.object({ allowed: z.boolean(), reason: z.string().nullable() }),
});
export type AtRiskMember = z.infer<typeof AtRiskMember>;

export const Intervention = z.object({
  id: Id,
  memberId: Id,
  memberName: z.string(),
  branchId: Id,
  branchName: z.string(),
  ticketId: Id.nullable(),
  ticketReference: z.string().nullable(),
  /** Frozen at creation. Risk is recomputed live, so without this the question
   *  "did contacting people at 71 work?" stops being answerable. */
  riskScoreAtCreation: z.number().int(),
  riskBandAtCreation: RiskBand,
  riskReasonsAtCreation: z.array(RiskReason),
  recommendedAction: z.string(),
  action: InterventionAction,
  note: z.string(),
  assigneeId: Id.nullable(),
  assigneeName: z.string().nullable(),
  dueAt: IsoDateTime,
  overdue: z.boolean(),
  state: InterventionState,
  outcome: InterventionOutcome.nullable(),
  outcomeNote: z.string().nullable(),
  createdBy: z.string(),
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
});
export type Intervention = z.infer<typeof Intervention>;

export const InterventionEffectiveness = z.object({
  action: InterventionAction,
  attempted: z.number().int(),
  retained: z.number().int(),
  churned: z.number().int(),
  noContact: z.number().int(),
  falsePositive: z.number().int(),
  pending: z.number().int(),
  /** Null until there are enough judged cases to divide by (PF-RPT-004). */
  retentionRate: z.number().int().nullable(),
});
export type InterventionEffectiveness = z.infer<typeof InterventionEffectiveness>;

export const RetentionView = z.object({
  atRisk: z.array(AtRiskMember),
  interventions: z.array(Intervention),
  effectiveness: z.array(InterventionEffectiveness),
  bands: z.object({ high: z.number().int(), watch: z.number().int(), low: z.number().int() }),
  /** Risk is a live computation over the ledgers, so it is real-time by
   *  construction; PF-DASH-003 wants that stated rather than assumed. */
  asOf: IsoDateTime,
});
export type RetentionView = z.infer<typeof RetentionView>;

/* — Requests ——————————————————————————————————————————————— */

export const TicketCreateRequest = z.object({
  memberId: Id.nullable().default(null),
  branchId: Id.nullable().default(null),
  category: TicketCategory,
  subject: z.string().min(3).max(160),
  body: z.string().min(1).max(4000),
  priority: TicketPriority.default('normal'),
});
export type TicketCreateRequest = z.infer<typeof TicketCreateRequest>;

export const TicketReplyRequest = z.object({
  body: z.string().min(1).max(4000),
  /** An internal note never reaches the member and never starts the SLA clock. */
  internal: z.boolean().default(false),
});
export type TicketReplyRequest = z.infer<typeof TicketReplyRequest>;

export const TicketPatchRequest = z.object({
  assigneeId: Id.nullable().optional(),
  priority: TicketPriority.optional(),
  state: TicketState.optional(),
  vulnerabilityFlag: z.boolean().optional(),
});
export type TicketPatchRequest = z.infer<typeof TicketPatchRequest>;
