import { reconcileMembershipDates } from '../../services/membership-dates.js';
import { Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { channels } from '@shark/contracts';
import { db, schema } from '../../db/client.js';
import { ctxOf } from '../../middleware/index.js';
import { emit } from '../../lib/events.js';
import { notFound } from '../../lib/errors.js';
import { MINUTE, isoDate, now, relativeTime } from '../../lib/time.js';
import { validate } from '../../middleware/validate.js';
import { memberPass } from '../../services/member-pass.js';

export const passRoutes = new Hono();

const PassQuery = z.object({ branchId: z.string().min(1).max(64).optional() });

passRoutes.get('/', validate('query', PassQuery), (c) => {
  const ctx = ctxOf(c);
  // A pass carries live, single-use credentials: never cached by anything.
  c.header('Cache-Control', 'no-store');
  return c.json(memberPass(ctx, c.req.valid('query').branchId));
});

passRoutes.post('/check-out', (c) => {
  const ctx = ctxOf(c);
  const memberId = ctx.memberId!;
  reconcileMembershipDates(memberId);
  const open = db
    .select()
    .from(schema.checkIns)
    .where(
      and(
        eq(schema.checkIns.tenantId, ctx.tenantId),
        eq(schema.checkIns.memberId, memberId),
        eq(schema.checkIns.decision, 'granted'),
        isNull(schema.checkIns.exitedAt),
      ),
    )
    .orderBy(desc(schema.checkIns.enteredAt))
    .get();
  if (!open) throw notFound('An open session');

  db.update(schema.checkIns).set({ exitedAt: now() }).where(eq(schema.checkIns.id, open.id)).run();
  emit({
    tenantId: ctx.tenantId,
    branchId: open.branchId,
    channel: channels.branch(open.branchId),
    topic: 'attendance.checked_out',
    payload: { memberId, checkInId: open.id },
  });
  return c.json({
    ok: true,
    minutesInside: Math.round((now() - open.enteredAt) / MINUTE),
    at: new Date(now()).toISOString(),
  });
});

passRoutes.get('/history', (c) => {
  const ctx = ctxOf(c);
  const rows = db
    .select()
    .from(schema.checkIns)
    .where(and(eq(schema.checkIns.tenantId, ctx.tenantId), eq(schema.checkIns.memberId, ctx.memberId!)))
    .orderBy(desc(schema.checkIns.enteredAt))
    .limit(60)
    .all();

  const branch = ctx.activeBranchId
    ? db.select().from(schema.branches).where(eq(schema.branches.id, ctx.activeBranchId)).get()
    : null;
  const tz = branch?.timezone ?? 'Asia/Kolkata';
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      date: isoDate(r.enteredAt, tz),
      granted: r.decision === 'granted',
      decision: r.decision,
      minutes: r.exitedAt ? Math.round((r.exitedAt - r.enteredAt) / MINUTE) : null,
      relativeTime: relativeTime(r.enteredAt),
    })),
  });
});
