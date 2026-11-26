import { Hono } from 'hono';
import { z } from 'zod';
import { ctxOf, rateLimit } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import { runIdempotently } from '../../lib/idempotency.js';
import {
  TASK_PRIORITIES,
  TASK_SOURCES,
  assignableStaff,
  completeTask,
  createTask,
  listTasks,
  taskDetail,
  taskSummary,
  updateTask,
} from '../../services/tasks.js';

/**
 * Tasks (P07). Thin adapter over services/tasks.ts.
 * Mounted by `app.ts` at `/v1/admin/tasks`.
 */
export const taskRoutes = new Hono();
const taskWriteLimit = rateLimit(120, 60_000, { identity: 'actor', bucket: 'admin-task-write' });

const Iso = z.string().datetime({ offset: true });

taskRoutes.get(
  '/',
  validate('query', z.object({ view: z.enum(['mine', 'open', 'done']).optional().default('open'), source: z.enum(TASK_SOURCES).optional() })),
  (c) => {
    const { view, source } = c.req.valid('query');
    return c.json(listTasks(ctxOf(c), view, source));
  },
);

taskRoutes.get('/summary', (c) => c.json(taskSummary(ctxOf(c))));

taskRoutes.get('/assignees', validate('query', z.object({ branchId: z.string().min(1) })), (c) =>
  c.json(assignableStaff(ctxOf(c), c.req.valid('query').branchId)),
);

const TaskBody = z
  .object({
    branchId: z.string().min(1),
    title: z.string().trim().min(3).max(160),
    detail: z.string().trim().max(2000).optional(),
    assigneeStaffId: z.string().min(1).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueAt: Iso.nullable().optional(),
    memberId: z.string().min(1).nullable().optional(),
    leadId: z.string().min(1).nullable().optional(),
    link: z.string().regex(/^\/[A-Za-z0-9/_?=&.-]*$/).max(300).nullable().optional(),
  })
  .strict();

taskRoutes.post('/', taskWriteLimit, validate('json', TaskBody), (c) => {
  const ctx = ctxOf(c);
  const body = c.req.valid('json');
  return c.json(runIdempotently(ctx, '/admin/tasks', c.req.header('idempotency-key'), body, () => createTask(ctx, body)), 201);
});

taskRoutes.get('/:taskId', (c) => c.json(taskDetail(ctxOf(c), c.req.param('taskId'))));

taskRoutes.patch(
  '/:taskId',
  taskWriteLimit,
  validate(
    'json',
    z
      .object({
        title: z.string().trim().min(3).max(160).optional(),
        detail: z.string().trim().max(2000).optional(),
        assigneeStaffId: z.string().min(1).nullable().optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        status: z.enum(['open', 'in_progress', 'cancelled']).optional(),
        dueAt: Iso.nullable().optional(),
      })
      .strict(),
  ),
  (c) => c.json(updateTask(ctxOf(c), c.req.param('taskId'), c.req.valid('json'))),
);

taskRoutes.post('/:taskId/complete', taskWriteLimit, validate('json', z.object({ outcome: z.string().trim().min(3).max(2000) })), (c) =>
  c.json(completeTask(ctxOf(c), c.req.param('taskId'), c.req.valid('json').outcome)),
);
