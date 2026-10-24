import { Hono } from 'hono';
import { z } from 'zod';
import {
  BranchInput,
  BranchPatch,
  BranchStateInput,
  BusinessProfilePatch,
  RoomInput,
} from '@shark/contracts';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  branchDetail,
  businessProfile,
  changeBranchState,
  createBranch,
  createRoom,
  deleteRoom,
  listBranches,
  setup,
  updateBranch,
  inUseTimezones,
  updateBusinessProfile,
} from '../../services/settings.js';

/**
 * Tenant and branch configuration (PF-TEN). A thin adapter: validate,
 * delegate, serialise.
 *
 * Every rule — which lifecycle move is legal, which settings a branch may
 * differ on, what a currency change does to invoices already raised — lives in
 * `services/settings.ts` and `@shark/domain`, so a second caller cannot get a
 * different answer. `settings.manage` is checked in the service rather than
 * here for the same reason.
 *
 * Mounted by `app.ts` at `/v1/admin/settings`.
 */
export const settingsRoutes = new Hono();

/* — Business profile (PF-TEN-001, PF-TEN-005) —————————————————— */

settingsRoutes.get('/business', (c) => c.json(businessProfile(ctxOf(c))));

settingsRoutes.patch('/business', validate('json', BusinessProfilePatch), (c) =>
  c.json(updateBusinessProfile(ctxOf(c), c.req.valid('json'))),
);

/* — Guided setup (PF-TEN-006) ——————————————————————————— */

settingsRoutes.get('/setup', (c) => c.json(setup(ctxOf(c))));

/* — Branches (PF-TEN-002, PF-TEN-003, PF-TEN-004) ————————————— */

settingsRoutes.get('/branches', (c) => c.json(listBranches(ctxOf(c))));

settingsRoutes.get('/branches/:branchId', (c) =>
  c.json({ branch: branchDetail(ctxOf(c), c.req.param('branchId')) }),
);

settingsRoutes.post('/branches', validate('json', BranchInput), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  // Creating a branch twice from one lost response would leave a duplicate
  // slug conflict at best and a phantom site at worst.
  const response = runIdempotently(ctx, '/admin/settings/branches', c.req.header('idempotency-key'), body, () => ({
    branch: createBranch(ctx, body),
  }));
  return c.json(response, 201);
});

settingsRoutes.patch('/branches/:branchId', validate('json', BranchPatch), (c) =>
  c.json({ branch: updateBranch(ctxOf(c), c.req.param('branchId'), c.req.valid('json')) }),
);

settingsRoutes.post('/branches/:branchId/state', validate('json', BranchStateInput), (c) =>
  c.json({ branch: changeBranchState(ctxOf(c), c.req.param('branchId'), c.req.valid('json')) }),
);

/* — Rooms and areas ————————————————————————————————————— */

settingsRoutes.post('/branches/:branchId/rooms', validate('json', RoomInput), (c) =>
  c.json(createRoom(ctxOf(c), c.req.param('branchId'), c.req.valid('json')), 201),
);

settingsRoutes.delete('/rooms/:roomId', (c) => c.json(deleteRoom(ctxOf(c), c.req.param('roomId'))));

/* — Timezones ——————————————————————————————————————————— */

/**
 * The zones a branch may be created in.
 *
 * Taken from the runtime rather than hard-coded: a list in the source goes
 * stale the next time a country changes its rules, and a branch stored with a
 * zone the server cannot resolve makes every date on that branch throw at read
 * time.
 *
 * Two corrections on top of what ICU hands over.
 *
 * **Zones already in use are always offered.** Node's bundled ICU reports the
 * *legacy* name for several zones — this build lists `Asia/Calcutta` and never
 * `Asia/Kolkata`, which is the name every branch in the seed is stored under.
 * A picker that cannot offer a branch its own current timezone reads as
 * broken, and re-saving would silently rewrite it to a different string for no
 * reason.
 *
 * **The renamed zones are searchable by the name people use.** Nobody in
 * Bengaluru searches for Calcutta. The map is small and only covers renames
 * that actually happened; it is not an attempt to translate the database.
 */
const ZONE_ALIASES: Record<string, string[]> = {
  'Asia/Calcutta': ['Asia/Kolkata', 'Kolkata', 'Bengaluru', 'Bangalore', 'Mumbai', 'Delhi', 'India'],
  'Asia/Kolkata': ['Asia/Calcutta', 'Kolkata', 'Bengaluru', 'Bangalore', 'Mumbai', 'Delhi', 'India'],
  'Asia/Saigon': ['Asia/Ho_Chi_Minh', 'Ho Chi Minh'],
  'Asia/Ho_Chi_Minh': ['Asia/Saigon', 'Saigon'],
  'Asia/Rangoon': ['Asia/Yangon', 'Yangon'],
  'Asia/Yangon': ['Asia/Rangoon', 'Rangoon'],
  'Asia/Katmandu': ['Asia/Kathmandu', 'Kathmandu'],
  'Asia/Kathmandu': ['Asia/Katmandu', 'Katmandu'],
  'Europe/Kiev': ['Europe/Kyiv', 'Kyiv'],
  'Europe/Kyiv': ['Europe/Kiev', 'Kiev'],
  'Africa/Asmera': ['Africa/Asmara', 'Asmara'],
  'America/Godthab': ['America/Nuuk', 'Nuuk'],
};

settingsRoutes.get('/timezones', validate('query', z.object({ q: z.string().optional() })), (c) => {
  const ctx = ctxOf(c);
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Kolkata', 'UTC'];

  const inUse = inUseTimezones(ctx.tenantId);
  const all = [...new Set([...inUse, ...supported.filter((zone) => zone.includes('/'))])].sort();

  const q = (c.req.valid('query').q ?? '').trim().toLowerCase();
  const matches = (zone: string): boolean => {
    if (!q) return true;
    if (zone.toLowerCase().includes(q)) return true;
    return (ZONE_ALIASES[zone] ?? []).some((alias) => alias.toLowerCase().includes(q));
  };

  return c.json({ items: all.filter(matches).slice(0, 400) });
});
