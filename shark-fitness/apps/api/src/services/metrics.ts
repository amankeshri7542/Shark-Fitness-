import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/client.js';
import { SCHEDULED_JOB_NAMES } from '../jobs/scheduler.js';
import { runtimeConfig } from '../lib/config.js';
import type { ScrapeGauges } from '../lib/metrics.js';

/** Gauges read at scrape time from the database and the host, so they are
 *  true after a restart rather than reset by it. */
export function collectScrapeGauges(): ScrapeGauges {
  const lastSuccess = db
    .select({ job: schema.jobRuns.job, at: sql<number>`max(coalesce(${schema.jobRuns.finishedAt}, ${schema.jobRuns.startedAt}))` })
    .from(schema.jobRuns)
    .where(and(sql`${schema.jobRuns.status} = 'succeeded'`, inArray(schema.jobRuns.job, [...SCHEDULED_JOB_NAMES])))
    .groupBy(schema.jobRuns.job)
    .all();

  const undelivered =
    db.select({ n: sql<number>`count(*)` }).from(schema.outboxEvents).where(isNull(schema.outboxEvents.deliveredAt)).get()?.n ?? 0;

  const pageCount = Number(sqlite.pragma('page_count', { simple: true }));
  const pageSize = Number(sqlite.pragma('page_size', { simple: true }));

  return {
    jobLastSuccess: lastSuccess.map((row) => ({ job: row.job, timestampSeconds: Math.floor(row.at / 1_000) })),
    outboxUndelivered: undelivered,
    sqliteDbSizeBytes: pageCount * pageSize,
    dataFilesystem: dataFilesystem(),
    release: runtimeConfig.release,
  };
}

function dataFilesystem(): ScrapeGauges['dataFilesystem'] {
  try {
    const stats = statfsSync(dirname(resolve(runtimeConfig.databasePath)));
    return { sizeBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}
