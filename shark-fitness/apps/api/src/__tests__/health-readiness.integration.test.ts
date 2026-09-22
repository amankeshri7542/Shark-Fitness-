import { describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { readinessCheck } from '../lib/readiness.js';

describe('liveness and readiness', () => {
  it('keeps liveness cheap and proves the migrated database is ready separately', async () => {
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, status: 'alive' });

    const ready = await app.request('/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      status: 'ready',
      database: 'ready',
      schema: 'ready',
      configuration: 'ready',
    });
  });

  it('does not call a reachable but unmigrated database ready', () => {
    const database = {
      prepare(sql: string) {
        return {
          get: () => ({ value: 1 }),
          all: () => sql.includes('sqlite_master') ? [{ name: 'tenants' }] : [],
        };
      },
    };
    expect(readinessCheck(database)).toEqual({
      ok: false,
      database: 'ready',
      schema: 'missing',
      reason: 'schema_incomplete',
    });
  });

  it('reports an unavailable database without leaking its error', () => {
    const database = { prepare: () => { throw new Error('secret database path'); } };
    expect(readinessCheck(database as never)).toEqual({
      ok: false,
      database: 'unavailable',
      schema: 'missing',
      reason: 'database_unavailable',
    });
  });
});
