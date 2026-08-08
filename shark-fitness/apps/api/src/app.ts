import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authenticate, errorHandler, logger, memberOnly, requestId, staffOnly } from './middleware/index.js';
import { allowedOrigins, csrfProtection, securityHeaders } from './lib/security.js';

import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { doorRoutes } from './routes/door.js';

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

export const app = new Hono();

app.use('*', requestId);
app.use('*', logger);
app.use('*', securityHeaders);
app.use(
  '*',
  cors({
    origin: (origin) => (allowedOrigins().has(origin.replace(/\/$/, '')) ? origin : undefined),
    credentials: true,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'content-type',
      'x-branch-id',
      'x-request-id',
      'x-csrf-token',
      'idempotency-key',
      'x-reader-id',
      'x-reader-key',
    ],
    exposeHeaders: ['x-request-id'],
    maxAge: 600,
  }),
);
app.use('/v1/*', csrfProtection);

app.onError(errorHandler);
app.notFound((c) =>
  c.json(
    { error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.', requestId: c.get('requestId') ?? 'unknown' } },
    404,
  ),
);

app.get('/health', (c) => c.json({ ok: true, at: new Date().toISOString() }));

app.route('/v1/auth', authRoutes);
app.route('/v1/door', doorRoutes);

app.use('/v1/me/*', authenticate);
app.route('/v1/me', meRoutes);

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
