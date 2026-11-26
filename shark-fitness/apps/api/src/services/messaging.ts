import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { isMinor } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { branchScope, type RequestContext } from '../lib/context.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { id } from '../lib/ids.js';
import {
  ATTACHMENT_MAX_BYTES,
  mediaStorage,
  signMediaPath,
  sniffMime,
  stripImageMetadata,
  verifyMediaSignature,
} from '../lib/media-storage.js';
import { isoDate, now } from '../lib/time.js';
import { engagementSettings } from './engagement-settings.js';

/**
 * Shared rules for member conversations, used by the member routes and the
 * staff Inbox (P07; PF-COMM-001, UX-M12, PRD 04 ENT-CHILD-001/003).
 */

type Conversation = typeof schema.conversations.$inferSelect;
type Member = typeof schema.members.$inferSelect;

/* ——— Minors ————————————————————————————————————————————————— */

export function memberIsMinor(member: Pick<Member, 'dob' | 'tenantId' | 'homeBranchId'>, atMs = now()): boolean {
  return isMinor(member.dob, isoDate(atMs, branchTimeZone(member.tenantId, member.homeBranchId)));
}

export const MINOR_THREAD_REFUSAL =
  'Direct messages between staff and members under 18 are switched off at this gym. A parent or guardian can contact the desk, or speak to the team in person.';

/** Staff↔minor direct threads are refused unless the gym turned them on. */
export function assertMinorRule(member: Pick<Member, 'dob' | 'tenantId' | 'homeBranchId'>): void {
  if (!memberIsMinor(member)) return;
  if (engagementSettings(member.tenantId).allowStaffMinorMessaging) return;
  throw new AppError('FORBIDDEN', MINOR_THREAD_REFUSAL, { details: { reason: 'minor_messaging_disabled' } });
}

/* ——— Who on the staff may see a thread ——————————————————————— */

const MANAGER_ROLES = new Set(['owner', 'regional_manager', 'branch_manager', 'platform_admin']);

/**
 * Coach threads are between a member and their coach (and the managers who
 * supervise them); desk threads belong to front-of-house. A thread assigned
 * to someone is always theirs to see.
 */
export function staffCanSee(ctx: RequestContext, conversation: Conversation, member: Pick<Member, 'trainerId' | 'homeBranchId'>): boolean {
  if (!ctx.permissions.includes('inbox.view')) return false;
  const branchId = conversation.branchId ?? member.homeBranchId;
  if (!branchScope(ctx).includes(branchId)) return false;
  if (conversation.assignedStaffId && conversation.assignedStaffId === ctx.staffId) return true;
  if (MANAGER_ROLES.has(ctx.role)) return conversation.kind === 'coach' || conversation.kind === 'reception';
  if (ctx.role === 'trainer') {
    return conversation.kind === 'coach' && (conversation.staffId === ctx.staffId || member.trainerId === ctx.staffId);
  }
  return conversation.kind === 'reception';
}

/**
 * A member's coach threads follow the member to their new coach. Without
 * this, the previous coach kept reading (and being notified about) a member
 * they no longer coach, because the thread still named them (PF-STAFF-005).
 * A thread a manager handed to someone else (cover) keeps that assignee.
 */
export function handOverCoachThreads(tenantId: string, memberId: string, from: string | null, to: string | null): void {
  if (from === to) return;
  const where = and(
    eq(schema.conversations.tenantId, tenantId),
    eq(schema.conversations.memberId, memberId),
    eq(schema.conversations.kind, 'coach'),
  );
  db.update(schema.conversations).set({ staffId: to }).where(where).run();
  db.update(schema.conversations)
    .set({ assignedStaffId: to })
    .where(and(where, from ? eq(schema.conversations.assignedStaffId, from) : isNull(schema.conversations.assignedStaffId)))
    .run();
}

/** Loads a conversation the staff caller may see, or 404 (never 403: a 403 says it exists). */
export function loadConversationForStaff(ctx: RequestContext, conversationId: string): { conversation: Conversation; member: Member } {
  const conversation = db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.tenantId, ctx.tenantId)))
    .get();
  const member = conversation?.memberId
    ? db.select().from(schema.members).where(and(eq(schema.members.id, conversation.memberId), eq(schema.members.tenantId, ctx.tenantId))).get()
    : undefined;
  if (!conversation || !member || !staffCanSee(ctx, conversation, member)) throw notFound('That conversation');
  return { conversation, member };
}

/* ——— Attachments ——————————————————————————————————————————— */

export interface AttachmentPolicy {
  enabled: boolean;
  maxSizeMb: number;
  accept: string[];
  reason: string | null;
}

export const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export function attachmentPolicy(): AttachmentPolicy {
  if (!mediaStorage()) {
    return {
      enabled: false,
      maxSizeMb: 0,
      accept: [],
      reason: 'Photos and files cannot be sent from the app on this server yet. Show it at reception, or describe it here.',
    };
  }
  return { enabled: true, maxSizeMb: ATTACHMENT_MAX_BYTES / (1024 * 1024), accept: ATTACHMENT_TYPES, reason: null };
}

export interface AttachmentView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Signed, valid for five minutes, re-checks access when used. */
  url: string;
  /** Kept for the older client, which renders "did not upload" when true. */
  failed: boolean;
}

export const attachmentPath = (attachmentId: string) => `/v1/attachments/${attachmentId}`;

function view(row: typeof schema.messageAttachments.$inferSelect, atMs: number): AttachmentView {
  return {
    id: row.id,
    name: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: signMediaPath(attachmentPath(row.id), atMs),
    failed: false,
  };
}

/** Signed views of every live attachment on these messages, by message id. */
export function attachmentsByMessage(messageIds: string[], atMs = now()): Map<string, AttachmentView[]> {
  const out = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) return out;
  for (const row of db
    .select()
    .from(schema.messageAttachments)
    .where(and(inArray(schema.messageAttachments.messageId, messageIds), isNull(schema.messageAttachments.deletedAt)))
    .all()) {
    const list = out.get(row.messageId!) ?? [];
    list.push(view(row, atMs));
    out.set(row.messageId!, list);
  }
  return out;
}

function safeFileName(name: string, mime: string): string {
  const cleaned = name.replace(/[\\/\r\n"]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (cleaned) return cleaned;
  return mime === 'application/pdf' ? 'document.pdf' : 'photo';
}

/**
 * Stores one uploaded file for a conversation. The type is decided by the
 * bytes (a script renamed `.jpg` is refused), images lose their metadata
 * (EXIF GPS) before they are written, and the file is unattached until a
 * message claims it.
 */
export function storeAttachment(
  ctx: RequestContext,
  conversationId: string,
  file: { name: string; bytes: Uint8Array },
): AttachmentView {
  const storage = mediaStorage();
  if (!storage) throw invalid(attachmentPolicy().reason ?? 'Attachments are off.');
  if (file.bytes.byteLength === 0) throw invalid('That file is empty.');
  if (file.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'That file is over 10 MB. Send a smaller photo or a PDF under 10 MB.');
  }
  const mime = sniffMime(file.bytes);
  if (!mime) throw new AppError('VALIDATION_FAILED', 'Only photos (JPEG, PNG, WebP) and PDF documents can be attached.');

  const bytes = stripImageMetadata(mime, file.bytes);
  const attachmentId = id('att');
  const storageKey = `attachments/${ctx.tenantId}/${conversationId}/${attachmentId}`;
  storage.put(storageKey, bytes);
  db.insert(schema.messageAttachments)
    .values({
      id: attachmentId,
      tenantId: ctx.tenantId,
      conversationId,
      messageId: null,
      uploaderUserId: ctx.userId,
      storageKey,
      fileName: safeFileName(file.name, mime),
      mimeType: mime,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: now(),
      deletedAt: null,
    })
    .run();
  const row = db.select().from(schema.messageAttachments).where(eq(schema.messageAttachments.id, attachmentId)).get()!;
  return view(row, now());
}

/** Claims uploaded files for a message. Only the uploader's own unsent files in this thread. */
export function claimAttachments(ctx: RequestContext, conversationId: string, messageId: string, attachmentIds: string[]): void {
  if (attachmentIds.length === 0) return;
  const rows = db
    .select()
    .from(schema.messageAttachments)
    .where(and(inArray(schema.messageAttachments.id, attachmentIds), eq(schema.messageAttachments.tenantId, ctx.tenantId)))
    .all();
  const usable = rows.filter(
    (r) => r.conversationId === conversationId && r.uploaderUserId === ctx.userId && r.messageId === null && r.deletedAt === null,
  );
  if (usable.length !== new Set(attachmentIds).size) {
    throw invalid('One of those files is not available to send here. Attach it again.');
  }
  db.update(schema.messageAttachments)
    .set({ messageId })
    .where(inArray(schema.messageAttachments.id, attachmentIds))
    .run();
}

/**
 * Serves a file. The URL signature proves it was issued recently; the caller
 * must *also* be the member in the thread or staff allowed to see it, so a
 * leaked link is useless to anyone else even inside its five minutes.
 */
export function readAttachment(
  ctx: RequestContext,
  attachmentId: string,
  exp: string | undefined,
  sig: string | undefined,
): { bytes: Buffer; mimeType: string; fileName: string } {
  const check = verifyMediaSignature(attachmentPath(attachmentId), exp, sig, now());
  if (check === 'expired') throw forbidden('This link has expired. Open the conversation again to get a fresh one.');
  if (check === 'invalid') throw forbidden('This link is not valid.');

  const row = db
    .select()
    .from(schema.messageAttachments)
    .where(and(eq(schema.messageAttachments.id, attachmentId), eq(schema.messageAttachments.tenantId, ctx.tenantId)))
    .get();
  if (!row || row.deletedAt !== null) throw notFound('That file');
  const conversation = db.select().from(schema.conversations).where(eq(schema.conversations.id, row.conversationId)).get();
  const member = conversation?.memberId ? db.select().from(schema.members).where(eq(schema.members.id, conversation.memberId)).get() : undefined;
  if (!conversation || !member) throw notFound('That file');

  const allowed =
    ctx.role === 'member'
      ? conversation.memberId === ctx.memberId && (row.messageId !== null || row.uploaderUserId === ctx.userId)
      : row.messageId !== null && staffCanSee(ctx, conversation, member);
  if (!allowed) throw notFound('That file');

  const bytes = mediaStorage()?.get(row.storageKey);
  if (!bytes) throw notFound('That file');
  return { bytes, mimeType: row.mimeType, fileName: row.fileName };
}
