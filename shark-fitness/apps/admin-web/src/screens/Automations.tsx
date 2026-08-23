import { useNavigate, useSearch } from '@tanstack/react-router';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { PermissionState, Tabs } from '../ui/console';
import Rules from './automations/Rules';
import Templates from './automations/Templates';
import Runs from './automations/Runs';

/* ============================================================================
   Automations — event-triggered messaging (PF-COMM).

   Three surfaces for three questions asked at different rhythms: what is
   running (rules, checked weekly), what does it say (messages, written once
   and revised rarely), and what actually happened (history, opened when a
   member asks why they were or were not contacted).

   The module's whole risk is sending something to somebody who did not want
   it, so every surface leads with restraint: a rule's standing says
   "rehearsing" rather than "on", the audience preview gives equal room to who
   is being held back, and the history records refusals as prominently as
   sends.
   ========================================================================= */

const TABS = [
  { key: 'rules', label: 'Rules' },
  { key: 'templates', label: 'Messages' },
  { key: 'runs', label: 'History' },
] as const;

export type AutomationsTab = (typeof TABS)[number]['key'];

export default function AutomationsScreen() {
  const canManage = usePermission('automation.manage');
  const { tab } = useSearch({ from: '/console/automations' });
  const navigate = useNavigate({ from: '/automations' });

  if (!canManage) {
    return (
      <Page title="Automations">
        <PermissionState what="Automations" />
      </Page>
    );
  }

  return (
    <Page title="Automations" kicker={TABS.find((t) => t.key === tab)?.label}>
      <Tabs
        label="Automations"
        active={tab}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onChange={(key) => void navigate({ search: () => ({ tab: key as AutomationsTab }), replace: true })}
      />
      {tab === 'rules' ? <Rules /> : tab === 'templates' ? <Templates /> : <Runs />}
    </Page>
  );
}
