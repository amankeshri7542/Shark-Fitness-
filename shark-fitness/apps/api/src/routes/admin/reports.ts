import { Hono } from 'hono';
import { z } from 'zod';
import { ReportKind } from '@shark/contracts';
import { ctxOf } from '../../middleware/index.js';
import { validate } from '../../middleware/validate.js';
import {
  attendanceReport,
  exportReport,
  membershipReport,
  reportBranches,
  retentionReport,
  revenueReport,
  trainerReport,
} from '../../services/reports.js';

/**
 * Reports and analytics (PF-RPT). A thin adapter: validate, delegate,
 * serialise. Permission, branch scope, timezone and every withheld figure are
 * decided in the service so a second caller cannot get a different answer.
 *
 * Mounted by `app.ts` at `/v1/admin/reports`.
 */
export const reportsRoutes = new Hono();

/**
 * A range is two calendar dates in the reporting timezone, never timestamps.
 * "1 to 31 August" is what an operator means and what a report is filed for;
 * turning it into instants is the service's job, because only it knows which
 * branch's midnight applies.
 */
const RangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.string().min(1).optional(),
});

const ExportBody = RangeQuery.extend({ kind: ReportKind });

reportsRoutes.get('/branches', (c) => c.json({ items: reportBranches(ctxOf(c)) }));

reportsRoutes.get('/revenue', validate('query', RangeQuery), (c) =>
  c.json(revenueReport(ctxOf(c), c.req.valid('query'))),
);

reportsRoutes.get('/membership', validate('query', RangeQuery), (c) =>
  c.json(membershipReport(ctxOf(c), c.req.valid('query'))),
);

reportsRoutes.get('/attendance', validate('query', RangeQuery), (c) =>
  c.json(attendanceReport(ctxOf(c), c.req.valid('query'))),
);

reportsRoutes.get('/trainer', validate('query', RangeQuery), (c) =>
  c.json(trainerReport(ctxOf(c), c.req.valid('query'))),
);

reportsRoutes.get('/retention', validate('query', RangeQuery), (c) =>
  c.json(retentionReport(ctxOf(c), c.req.valid('query'))),
);

/**
 * POST rather than GET, because an export is an act with a record: it is
 * audited with the filters that produced it, and a GET that writes an audit
 * row is a GET a proxy may replay.
 *
 * The body is returned as JSON carrying the CSV rather than as a file
 * download, so the console can name the file, show the row count before
 * saving, and surface a permission refusal in the interface instead of a
 * browser error page.
 */
reportsRoutes.post('/export', validate('json', ExportBody), (c) =>
  c.json(exportReport(ctxOf(c), c.req.valid('json'))),
);
