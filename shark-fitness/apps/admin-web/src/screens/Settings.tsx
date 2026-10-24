import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { SetupChecklist } from '@shark/contracts';
import { api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Chip, PermissionState, Tabs } from '../ui/console';
import Business from './settings/Business';
import Branches from './settings/Branches';
import Privacy from './settings/Privacy';
import Setup from './settings/Setup';

/* ============================================================================
   Settings — tenant, branches and policy (PF-TEN).

   Four surfaces, ordered by how a gym is actually set up: what the company is,
   where it trades, what it promises about data, and what is left to do.

   The screen is deliberately a set of forms and tables rather than a
   dashboard. Nobody opens Settings to browse; they open it to change one
   thing, and every section commits on its own so changing that one thing does
   not drag three abandoned edits along with it.

   Which surface is open lives in the URL, because "set your tax number" is
   something one person sends another.
   ========================================================================= */

const TABS = [
  { key: 'business', label: 'Business' },
  { key: 'branches', label: 'Locations' },
  { key: 'privacy', label: 'Privacy' },
  { key: 'setup', label: 'Setup' },
] as const;

export type SettingsTab = (typeof TABS)[number]['key'];

export default function SettingsScreen() {
  const canManage = usePermission('settings.manage');
  const { tab } = useSearch({ from: '/console/settings' });
  const navigate = useNavigate({ from: '/settings' });

  // Loaded on every tab: the outstanding count belongs beside the tab that
  // clears it, not only on the tab nobody opens.
  const setup = useQuery({
    queryKey: ['settings', 'setup'],
    queryFn: () => api<SetupChecklist>('/admin/settings/setup'),
    enabled: canManage,
    staleTime: 30_000,
  });

  if (!canManage) {
    return (
      <Page title="Settings">
        <PermissionState what="Gym settings" />
      </Page>
    );
  }

  const outstanding = setup.data ? setup.data.total - setup.data.done : 0;

  return (
    <Page
      title="Settings"
      kicker={TABS.find((t) => t.key === tab)?.label}
      actions={
        setup.data && !setup.data.readyToOpen ? (
          <Chip tone="warn">
            {setup.data.items.filter((i) => i.blocking && !i.done).length} before members arrive
          </Chip>
        ) : setup.data ? (
          <Chip tone="good">Ready to open</Chip>
        ) : null
      }
    >
      <Tabs
        label="Settings"
        active={tab}
        items={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          ...(t.key === 'setup' && outstanding > 0 ? { hint: String(outstanding) } : {}),
        }))}
        onChange={(key) => void navigate({ search: () => ({ tab: key as SettingsTab }), replace: true })}
      />

      {tab === 'business' ? <Business canManage={canManage} /> : null}
      {tab === 'branches' ? <Branches canManage={canManage} /> : null}
      {tab === 'privacy' ? <Privacy canManage={canManage} /> : null}
      {tab === 'setup' ? <Setup canManage={canManage} /> : null}
    </Page>
  );
}
