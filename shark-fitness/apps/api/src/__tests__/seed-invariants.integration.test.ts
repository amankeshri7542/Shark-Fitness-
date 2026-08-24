import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { sqlite } from '../db/client.js';
import { SEED_WIPE_TABLES, wipeSeedTables } from '../db/seed-tables.js';

describe('deterministic seed reset', () => {
  it('wipes every application table in reverse dependency order', () => {
    const schemaTables = (
      sqlite
        .prepare(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const configured = new Set<string>(SEED_WIPE_TABLES);

    expect(configured.size).toBe(SEED_WIPE_TABLES.length);
    expect(schemaTables.filter((table) => !configured.has(table))).toEqual([]);
    expect(SEED_WIPE_TABLES.filter((table) => !schemaTables.includes(table))).toEqual([]);
  });

  it('temporarily removes and then restores append-only triggers during a destructive demo reset', () => {
    const scratch = new Database(':memory:');
    try {
      scratch.exec(`
        create table ledger (id text primary key, value text not null);
        create trigger ledger_no_delete before delete on ledger
          begin select raise(abort, 'ledger is append-only'); end;
        insert into ledger values ('old', 'orphan-prone');
      `);

      wipeSeedTables(scratch, ['ledger']);
      expect(scratch.prepare('select count(*) as count from ledger').get()).toEqual({ count: 0 });

      scratch.exec("insert into ledger values ('new', 'protected')");
      expect(() => scratch.exec("delete from ledger where id = 'new'")).toThrow(/append-only/);
    } finally {
      scratch.close();
    }
  });
});
