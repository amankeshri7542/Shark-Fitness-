import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Automations — see docs/BUILD-PLAN.md for the owning slice. */
export default function AutomationsScreen() {
  return (
    <Page title="Automations">
      <EmptyState title="Automations" body="This module is being built." />
    </Page>
  );
}
