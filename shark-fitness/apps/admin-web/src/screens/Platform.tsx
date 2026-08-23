import { useNavigate, useSearch } from '@tanstack/react-router';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { PermissionState, Tabs } from '../ui/console';
import Tenants from './platform/Tenants';
import Health from './platform/Health';

/* ============================================================================
   Platform — the operator's console (PF-PLAT).

   Two surfaces, because there are two jobs: *who are our customers and what do
   they need* and *is the thing running*. Both are tables. A gym over its quota
   or a queue that stopped draining is a row you act on, not a figure you
   admire, and nothing here is decorated to fill space.

   The whole screen is behind `platform.admin`, which no tenant role holds and
   an impersonated session cannot regain. A support operator holding only
   `platform.impersonate` does not see it — they reach customer accounts from
   the ticket they are working, not by browsing the estate.
   ========================================================================= */

const TABS = [
  { key: 'tenants', label: 'Customers' },
  { key: 'health', label: 'Health' },
] as const;

export type PlatformTab = (typeof TABS)[number]['key'];

export default function PlatformScreen() {
  const canAdminister = usePermission('platform.admin');
  const canImpersonate = usePermission('platform.impersonate');
  const { tab } = useSearch({ from: '/console/platform' });
  const navigate = useNavigate({ from: '/platform' });

  if (!canImpersonate) {
    return (
      <Page title="Platform">
        <PermissionState what="Platform administration" />
      </Page>
    );
  }

  // Support sees customers so they can reach an account. Health and the
  // controls that change a gym's standing are administration.
  const visible = TABS.filter((t) => t.key === 'tenants' || canAdminister);
  const active = visible.some((t) => t.key === tab) ? tab : 'tenants';

  return (
    <Page title="Platform" kicker={visible.find((t) => t.key === active)?.label}>
      {visible.length > 1 ? (
        <Tabs
          label="Platform"
          active={active}
          items={visible.map((t) => ({ key: t.key, label: t.label }))}
          onChange={(key) => void navigate({ search: () => ({ tab: key as PlatformTab }), replace: true })}
        />
      ) : null}
      {active === 'tenants' ? <Tenants canAdminister={canAdminister} /> : <Health />}
    </Page>
  );
}
