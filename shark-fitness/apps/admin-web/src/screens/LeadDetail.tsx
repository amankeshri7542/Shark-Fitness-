import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): LeadDetail — see docs/BUILD-PLAN.md for the owning slice. */
export default function LeadDetailScreen() {
  return (
    <Page title="LeadDetail">
      <EmptyState title="LeadDetail" body="This module is being built." />
    </Page>
  );
}
