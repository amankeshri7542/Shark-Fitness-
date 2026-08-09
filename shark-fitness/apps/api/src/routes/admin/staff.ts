import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { Role } from '@shark/contracts';
import { db, schema } from '../../db/client.js';
import { requirePermission } from '../../lib/context.js';
import { ctxOf } from '../../middleware/index.js';
import {
  assignmentsForTrainer,
  createShift,
  createStaffMember,
  listShifts,
  listStaff,
  loadStaffInScope,
  updateEmployment,
  updateShiftState,
} from '../../services/staff.js';
import { DAY, now } from '../../lib/time.js';

/**
 * Staff directory, employment and availability (PF-STAFF). Route files are
 * thin adapters — every rule lives in `services/staff.ts`.
 */
export const staffRoutes = new Hono();

const ListQuery = z.object({
  q: z.string().optional(),
  role: Role.optional(),
  employmentStatus: z.enum(['active', 'on_leave', 'notice', 'former']).optional(),
});

staffRoutes.get('/', validate('query', ListQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.view');
  const query = c.req.valid('query');
  return c.json(listStaff(ctx, query));
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email().nullable().default(null),
  phone: z.string().nullable().default(null),
  role: Role,
  branchIds: z.array(z.string().min(1)).min(1),
  specialties: z.array(z.string()).default([]),
});

staffRoutes.post('/', validate('json', CreateBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.manage');
  const staff = createStaffMember(ctx, c.req.valid('json'));
  return c.json({ staff: { id: staff.id } }, 201);
});

staffRoutes.get('/:staffId', (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.view');
  const staffId = c.req.param('staffId');
  const staff = loadStaffInScope(ctx, staffId);
  const user = db
    .select({ name: schema.users.name, initials: schema.users.initials, email: schema.users.email, phone: schema.users.phone, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, staff.userId))
    .get();

  const canSeeCommission = ctx.permissions.includes('staff.commission');
  const workload = assignmentsForTrainer(ctx, staffId);

  const atMs = now();
  const shifts = listShifts(ctx, { staffId, from: atMs - 7 * DAY, to: atMs + 21 * DAY });

  return c.json({
    staff: {
      id: staff.id,
      name: user?.name ?? '',
      initials: user?.initials ?? '??',
      email: user?.email ?? null,
      phone: user?.phone ?? null,
      role: user?.role ?? '',
      employmentStatus: staff.employmentStatus,
      branchIds: staff.branchIds,
      specialties: staff.specialties,
      certifications: staff.certifications,
      hourlyRateMinor: canSeeCommission ? staff.hourlyRateMinor : null,
      commissionRules: canSeeCommission ? staff.commissionRules : [],
      joinedOn: staff.joinedOn,
    },
    workload,
    shifts: shifts.map((s) => ({
      id: s.id,
      branchId: s.branchId,
      startsAt: new Date(s.startsAt).toISOString(),
      endsAt: new Date(s.endsAt).toISOString(),
      role: s.role,
      state: s.state,
      coveredByStaffId: s.coveredByStaffId,
      note: s.note,
    })),
  });
});

const PatchBody = z.object({
  employmentStatus: z.enum(['active', 'on_leave', 'notice', 'former']).optional(),
  branchIds: z.array(z.string().min(1)).min(1).optional(),
  specialties: z.array(z.string()).optional(),
  certifications: z.array(z.object({ name: z.string().min(1), expiresOn: z.string().nullable() })).optional(),
  commissionRules: z.array(z.object({ kind: z.string().min(1), ratePct: z.number().min(0).max(100) })).optional(),
  hourlyRateMinor: z.number().int().min(0).nullable().optional(),
});

staffRoutes.patch('/:staffId', validate('json', PatchBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.manage');
  const body = c.req.valid('json');
  // Commission and pay rate are gated by a second, dedicated permission —
  // ordinary staff-management access does not extend to changing what
  // someone is paid.
  if (body.commissionRules !== undefined || body.hourlyRateMinor !== undefined) {
    requirePermission(ctx, 'staff.commission');
  }
  const staff = updateEmployment(ctx, c.req.param('staffId'), body);
  return c.json({ staff: { id: staff.id, employmentStatus: staff.employmentStatus } });
});

const ShiftQuery = z.object({
  branchId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

staffRoutes.get('/:staffId/shifts', validate('query', ShiftQuery), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.view');
  const staffId = c.req.param('staffId');
  const query = c.req.valid('query');
  const atMs = now();
  const shifts = listShifts(ctx, {
    staffId,
    branchId: query.branchId,
    from: query.from ? Date.parse(query.from) : atMs - 7 * DAY,
    to: query.to ? Date.parse(query.to) : atMs + 21 * DAY,
  });
  return c.json({
    items: shifts.map((s) => ({
      id: s.id,
      branchId: s.branchId,
      staffId: s.staffId,
      startsAt: new Date(s.startsAt).toISOString(),
      endsAt: new Date(s.endsAt).toISOString(),
      role: s.role,
      state: s.state,
      coveredByStaffId: s.coveredByStaffId,
      note: s.note,
    })),
  });
});

const CreateShiftBody = z.object({
  branchId: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  role: z.string().min(1),
  note: z.string().max(280).nullable().default(null),
});

staffRoutes.post('/:staffId/shifts', validate('json', CreateShiftBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.manage');
  const body = c.req.valid('json');
  const shift = createShift(ctx, {
    staffId: c.req.param('staffId'),
    branchId: body.branchId,
    startsAt: Date.parse(body.startsAt),
    endsAt: Date.parse(body.endsAt),
    role: body.role,
    note: body.note,
  });
  return c.json({ shift: { id: shift.id } }, 201);
});

const ShiftPatchBody = z.object({
  state: z.enum(['planned', 'confirmed', 'in_progress', 'completed', 'absent', 'covered']),
  coveredByStaffId: z.string().nullable().optional(),
  note: z.string().max(280).nullable().optional(),
});

staffRoutes.patch('/shifts/:shiftId', validate('json', ShiftPatchBody), (c) => {
  const ctx = ctxOf(c);
  requirePermission(ctx, 'staff.manage');
  const shift = updateShiftState(ctx, c.req.param('shiftId'), c.req.valid('json'));
  return c.json({ shift: { id: shift.id, state: shift.state } });
});
