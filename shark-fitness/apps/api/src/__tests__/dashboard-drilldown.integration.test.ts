import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app } from '../app.js';
import { db, schema } from '../db/client.js';
import { createSession } from '../services/auth.js';

interface Kpi {
  key: string;
  value: number;
  drillTo: string | null;
}

interface MemberList {
  total: number;
  items: Array<{
    lifecycle: string;
    joinedOn: string;
    endsOn: string | null;
    autoRenew: boolean | null;
  }>;
}

describe('dashboard drill-downs', () => {
  it('opens source lists with the same member and invoice predicates as the KPI', async () => {
    const owner = db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, 'ten_shark'), eq(schema.users.email, 'owner@sharkfitness.in')))
      .get()!;
    const session = createSession(owner.id, owner.tenantId, '192.0.2.82', 'dashboard-drill-regression');
    const headers = { authorization: `Bearer ${session.token}` };

    const dashboardResponse = await app.request('/v1/admin/dashboard', { headers });
    expect(dashboardResponse.status).toBe(200);
    const dashboard = (await dashboardResponse.json()) as { kpis: Kpi[] };
    const kpi = (key: string): Kpi => dashboard.kpis.find((item) => item.key === key)!;
    const read = (path: string) => app.request(`/v1/admin${path}`, { headers });

    const activeResponse = await read(kpi('active_members').drillTo!);
    const active = (await activeResponse.json()) as MemberList;
    expect(activeResponse.status).toBe(200);
    expect(active.total).toBe(kpi('active_members').value);
    expect(active.items.every((member) => ['active', 'trial', 'corporate'].includes(member.lifecycle))).toBe(true);

    const joinedResponse = await read(kpi('joined_month').drillTo!);
    const joined = (await joinedResponse.json()) as MemberList;
    expect(joinedResponse.status).toBe(200);
    expect(joined.total).toBe(kpi('joined_month').value);

    const expiringResponse = await read(kpi('expiring').drillTo!);
    const expiring = (await expiringResponse.json()) as MemberList;
    expect(expiringResponse.status).toBe(200);
    expect(expiring.total).toBe(kpi('expiring').value);
    expect(expiring.items.every((member) => member.endsOn !== null && member.autoRenew === false)).toBe(true);

    const outstandingPath = kpi('outstanding').drillTo!.replace('/billing', '/billing/invoices');
    const outstandingResponse = await read(outstandingPath);
    expect(outstandingResponse.status).toBe(200);
    const outstanding = (await outstandingResponse.json()) as { items: Array<{ state: string }> };
    expect(outstanding.items.every((invoice) => ['open', 'partially_paid', 'overdue'].includes(invoice.state))).toBe(true);
  });
});
