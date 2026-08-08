import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Leads — see docs/BUILD-PLAN.md for the owning slice. */
export default function LeadsScreen() {
  return (
    <Page title="Leads">
      <EmptyState title="Leads" body="This module is being built." />
    </Page>
  );
}
