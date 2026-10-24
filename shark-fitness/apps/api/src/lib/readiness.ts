import { sqlite } from '../db/client.js';

interface PreparedRead {
  get(): unknown;
  all(): unknown[];
}

interface ReadinessDatabase {
  prepare(sql: string): PreparedRead;
}

const REQUIRED_TABLES = ['tenants', 'users', 'sessions', 'audit_log', 'job_runs'] as const;
const REQUIRED_JOB_RUN_COLUMNS = ['summary', 'error_category', 'build_id'] as const;

export interface ReadinessResult {
  ok: boolean;
  database: 'ready' | 'unavailable';
  schema: 'ready' | 'missing';
  reason?: 'database_unavailable' | 'schema_incomplete';
}

/** Non-destructive readiness proof: the connection answers and the latest
 * operational schema used by this build is present. */
export function readinessCheck(database: ReadinessDatabase = sqlite): ReadinessResult {
  try {
    database.prepare('select 1').get();
    const tables = database
      .prepare(`select name from sqlite_master where type = 'table' and name in (${REQUIRED_TABLES.map((name) => `'${name}'`).join(',')})`)
      .all() as Array<{ name?: string }>;
    const tableNames = new Set(tables.map((row) => row.name));
    const columns = database.prepare("pragma table_info('job_runs')").all() as Array<{ name?: string }>;
    const columnNames = new Set(columns.map((row) => row.name));
    if (
      REQUIRED_TABLES.some((name) => !tableNames.has(name)) ||
      REQUIRED_JOB_RUN_COLUMNS.some((name) => !columnNames.has(name))
    ) {
      return { ok: false, database: 'ready', schema: 'missing', reason: 'schema_incomplete' };
    }
    return { ok: true, database: 'ready', schema: 'ready' };
  } catch {
    return { ok: false, database: 'unavailable', schema: 'missing', reason: 'database_unavailable' };
  }
}
