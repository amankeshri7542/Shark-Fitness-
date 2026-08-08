import { z } from 'zod';
import { Channel, ModerationState, TicketPriority, TicketState, Visibility } from '../enums.js';
import { Id, IsoDate, IsoDateTime, Money } from './identity.js';

/* — Gamification (PF-GAME) ——————————————————————————————————— */

export const LevelInfo = z.object({
  level: z.number().int(),
  name: z.string(), // Reef · Tiger · Great White · Megalodon
  xp: z.number().int(),
  xpIntoLevel: z.number().int(),
  xpForNextLevel: z.number().int(),
  progressPct: z.number().int().min(0).max(100),
  nextName: z.string().nullable(),
});
export type LevelInfo = z.infer<typeof LevelInfo>;

export const XpEntry = z.object({
  id: Id,
  delta: z.number().int(),
  reason: z.string(),
  refType: z.string().nullable(),
  refId: Id.nullable(),
  at: IsoDateTime,
  /** True for reversals. Corrections are compensating entries, never edits
   *  or deletions of the original (PF-GAME-002). */
  isCorrection: z.boolean(),
});
export type XpEntry = z.infer<typeof XpEntry>;

export const Streak = z.object({
  current: z.number().int(),
  longest: z.number().int(),
  weeklyTarget: z.number().int(),
  thisWeek: z.number().int(),
  lastSessionOn: IsoDate.nullable(),
  /** Days of grace before the streak breaks. Streaks never punish illness. */
  restDaysAllowed: z.number().int(),
  /** Mon–Sun, true where a session was logged. */
  week: z.array(z.boolean()).length(7),
});
export type Streak = z.infer<typeof Streak>;

export const Achievement = z.object({
  id: Id,
  code: z.string(),
  name: z.string(),
  description: z.string(),
  earnedAt: IsoDateTime.nullable(),
  progressPct: z.number().int().min(0).max(100),
  tier: z.enum(['bronze', 'silver', 'gold']),
});
export type Achievement = z.infer<typeof Achievement>;

export const Challenge = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  /** Ranked on attendance and consistency. Volume and body metrics are never
   *  ranked — fairness rule, PF-GAME-004. */
  metric: z.enum(['sessions', 'consistency', 'habit_days', 'class_count', 'team_sessions']),
  metricLabel: z.string(),
  startsOn: IsoDate,
  endsOn: IsoDate,
  daysLeft: z.number().int(),
  branchId: Id.nullable(),
  branchName: z.string().nullable(),
  visibility: Visibility,
  teamMode: z.boolean(),
  teamTarget: z.number().int().nullable(),
  teamProgress: z.number().int().nullable(),
  participantCount: z.number().int(),
  joined: z.boolean(),
  myScore: z.number().int().nullable(),
  myRank: z.number().int().nullable(),
  rules: z.array(z.string()),
  rewardLabel: z.string().nullable(),
  /** Set when joining now still allows a fair result. */
  lateJoinNote: z.string().nullable(),
});
export type Challenge = z.infer<typeof Challenge>;

export const LeaderboardRow = z.object({
  rank: z.number().int(),
  memberId: Id.nullable(),
  /** "Shark #4417" when the member keeps their board entry private. */
  displayName: z.string(),
  initials: z.string(),
  score: z.number().int(),
  isYou: z.boolean(),
  isPrivate: z.boolean(),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

export const Referral = z.object({
  code: z.string(),
  invited: z.number().int(),
  joined: z.number().int(),
  target: z.number().int(),
  pendingRewardMinor: Money,
  earnedRewardMinor: Money,
  expiresOn: IsoDate.nullable(),
  invitees: z.array(
    z.object({
      name: z.string(),
      state: z.enum(['invited', 'signed_up', 'joined', 'expired', 'rejected']),
      at: IsoDateTime,
    }),
  ),
});
export type Referral = z.infer<typeof Referral>;

/* — Community (PF-GAME-005, UX-M11) ——————————————————————————— */

export const Post = z.object({
  id: Id,
  authorId: Id.nullable(),
  authorName: z.string(),
  authorInitials: z.string(),
  authorKind: z.enum(['member', 'staff', 'gym']),
  branchName: z.string().nullable(),
  createdAt: IsoDateTime,
  relativeTime: z.string(),
  kind: z.enum(['text', 'pr', 'workout', 'announcement', 'challenge']),
  body: z.string(),
  badge: z.string().nullable(),
  kudos: z.number().int(),
  kudosByMe: z.boolean(),
  commentCount: z.number().int(),
  visibility: Visibility,
  state: ModerationState,
  canReport: z.boolean(),
  canDelete: z.boolean(),
});
export type Post = z.infer<typeof Post>;

export const Comment = z.object({
  id: Id,
  postId: Id,
  authorName: z.string(),
  authorInitials: z.string(),
  body: z.string(),
  createdAt: IsoDateTime,
  state: ModerationState,
  canDelete: z.boolean(),
});
export type Comment = z.infer<typeof Comment>;

export const ReportInput = z.object({
  targetType: z.enum(['post', 'comment', 'member']),
  targetId: Id,
  reason: z.enum(['harassment', 'spam', 'unsafe_advice', 'impersonation', 'other']),
  note: z.string().max(1000).optional(),
});
export type ReportInput = z.infer<typeof ReportInput>;

/* — Messaging and support (UX-M12) ————————————————————————————— */

export const Conversation = z.object({
  id: Id,
  kind: z.enum(['coach', 'reception', 'support', 'group']),
  title: z.string(),
  counterpartName: z.string(),
  counterpartInitials: z.string(),
  counterpartRole: z.string(),
  lastMessage: z.string(),
  lastMessageAt: IsoDateTime,
  unread: z.number().int(),
  muted: z.boolean(),
  /** Staff hours. Sets expectation instead of leaving a member waiting. */
  responseWindow: z.string(),
  outsideHours: z.boolean(),
});
export type Conversation = z.infer<typeof Conversation>;

export const Message = z.object({
  id: Id,
  conversationId: Id,
  senderName: z.string(),
  senderInitials: z.string(),
  fromMe: z.boolean(),
  body: z.string(),
  createdAt: IsoDateTime,
  state: z.enum(['queued', 'sent', 'delivered', 'read', 'failed']),
  attachments: z.array(z.object({ name: z.string(), url: z.string(), sizeBytes: z.number().int() })),
  clientId: z.string().nullable(),
});
export type Message = z.infer<typeof Message>;

export const Ticket = z.object({
  id: Id,
  reference: z.string(),
  category: z.enum(['billing', 'membership', 'facility', 'class', 'app', 'complaint', 'other']),
  subject: z.string(),
  priority: TicketPriority,
  state: TicketState,
  openedAt: IsoDateTime,
  slaDueAt: IsoDateTime.nullable(),
  assigneeName: z.string().nullable(),
  memberName: z.string().optional(),
  lastUpdateAt: IsoDateTime,
  resolution: z.string().nullable(),
});
export type Ticket = z.infer<typeof Ticket>;

export const Notification = z.object({
  id: Id,
  channel: Channel,
  title: z.string(),
  body: z.string(),
  createdAt: IsoDateTime,
  readAt: IsoDateTime.nullable(),
  /** Deep link to the exact object, per UX rule "notifications deep-link". */
  link: z.string().nullable(),
  kind: z.enum(['booking', 'payment', 'coach', 'class', 'challenge', 'system', 'access']),
});
export type Notification = z.infer<typeof Notification>;

/* — Live and on-demand (UX-M13) ———————————————————————————————— */

export const MediaAsset = z.object({
  id: Id,
  title: z.string(),
  category: z.string(),
  trainerName: z.string(),
  durationSec: z.number().int(),
  level: z.enum(['beginner', 'intermediate', 'advanced']),
  equipment: z.array(z.string()),
  posterColor: z.string(),
  hasCaptions: z.boolean(),
  entitled: z.boolean(),
  entitlementNote: z.string().nullable(),
  progressSec: z.number().int(),
  favourite: z.boolean(),
  /** Null when the tenant's video quota is spent — the row still renders with
   *  an explanation rather than vanishing (PF-MEDIA-005). */
  playbackUrl: z.string().nullable(),
  unavailableReason: z.string().nullable(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const LiveSession = z.object({
  id: Id,
  title: z.string(),
  trainerName: z.string(),
  startsAt: IsoDateTime,
  state: z.enum(['scheduled', 'live', 'ended', 'unavailable']),
  participantCount: z.number().int(),
  entitled: z.boolean(),
  recordingPolicy: z.enum(['none', 'members_only', 'public']),
  /** When video is down, the class chat and attendance still work. */
  fallbackNote: z.string().nullable(),
});
export type LiveSession = z.infer<typeof LiveSession>;
