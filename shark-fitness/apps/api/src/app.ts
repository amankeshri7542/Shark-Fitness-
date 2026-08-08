import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  authenticate,
  errorHandler,
  logger,
  memberOnly,
  requestId,
  staffOnly,
} from './middleware/index.js';

import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';

import { homeRoutes } from './routes/member/home.js';
import { passRoutes } from './routes/member/pass.js';
import { scheduleRoutes as memberScheduleRoutes } from './routes/member/schedule.js';
import { trainingRoutes as memberTrainingRoutes } from './routes/member/training.js';
import { progressRoutes } from './routes/member/progress.js';
import { habitsRoutes } from './routes/member/habits.js';
import { engagementRoutes } from './routes/member/engagement.js';
import { messagesRoutes } from './routes/member/messages.js';
import { billingRoutes as memberBillingRoutes } from './routes/member/billing.js';
import { mediaRoutes } from './routes/member/media.js';

import { dashboardRoutes } from './routes/admin/dashboard.js';
import { membersRoutes } from './routes/admin/members.js';
import { leadsRoutes } from './routes/admin/leads.js';
import { billingRoutes as adminBillingRoutes } from './routes/admin/billing.js';
import { attendanceRoutes } from './routes/admin/attendance.js';
import { scheduleRoutes as adminScheduleRoutes } from './routes/admin/schedule.js';
import { trainingRoutes as adminTrainingRoutes } from './routes/admin/training.js';
import { staffRoutes } from './routes/admin/staff.js';
import { storeRoutes } from './routes/admin/store.js';
import { facilityRoutes } from './routes/admin/facility.js';
import { reportsRoutes } from './routes/admin/reports.js';
import { settingsRoutes } from './routes/admin/settings.js';
import { supportRoutes } from './routes/admin/support.js';

/**
 * Route adapter layer only. No business logic lives in this file or in the
 * modules it mounts beyond validation and serialisation — the rule is
 * "route adapter → auth → application service → domain rules → repository"
 * (Engineering PRD §"Architectural style").
 *
 * Feature modules own their own file. Nothing needs to edit this one to add a
 * handler, which is what keeps parallel work from colliding here.
 */
export const app = new Hono();

app.use('*', requestId);
app.use('*', logger);
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    credentials: true,
    allowHeaders: ['content-type', 'authorization', 'x-branch-id', 'x-request-id', 'idempotency-key'],
    exposeHeaders: ['x-request-id'],
  }),
);

app.onError(errorHandler);

app.notFound((c) =>
  c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'That endpoint does not exist.',
        requestId: c.get('requestId') ?? 'unknown',
      },
    },
    404,
  ),
);

app.get('/health', (c) => c.json({ ok: true, at: new Date().toISOString() }));

/* — Public ————————————————————————————————————————————————— */
app.route('/v1/auth', authRoutes);

/* — Any signed-in actor ——————————————————————————————————— */
app.use('/v1/me/*', authenticate);
app.route('/v1/me', meRoutes);

/* — Member app ————————————————————————————————————————————— */
app.use('/v1/member/*', authenticate, memberOnly);
app.route('/v1/member/home', homeRoutes);
app.route('/v1/member/pass', passRoutes);
app.route('/v1/member/schedule', memberScheduleRoutes);
app.route('/v1/member/training', memberTrainingRoutes);
app.route('/v1/member/progress', progressRoutes);
app.route('/v1/member/habits', habitsRoutes);
app.route('/v1/member/engagement', engagementRoutes);
app.route('/v1/member/messages', messagesRoutes);
app.route('/v1/member/billing', memberBillingRoutes);
app.route('/v1/member/media', mediaRoutes);

/* — Admin dashboard ———————————————————————————————————————— */
app.use('/v1/admin/*', authenticate, staffOnly);
app.route('/v1/admin/dashboard', dashboardRoutes);
app.route('/v1/admin/members', membersRoutes);
app.route('/v1/admin/leads', leadsRoutes);
app.route('/v1/admin/billing', adminBillingRoutes);
app.route('/v1/admin/attendance', attendanceRoutes);
app.route('/v1/admin/schedule', adminScheduleRoutes);
app.route('/v1/admin/training', adminTrainingRoutes);
app.route('/v1/admin/staff', staffRoutes);
app.route('/v1/admin/store', storeRoutes);
app.route('/v1/admin/facility', facilityRoutes);
app.route('/v1/admin/reports', reportsRoutes);
app.route('/v1/admin/settings', settingsRoutes);
app.route('/v1/admin/support', supportRoutes);
