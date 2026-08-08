import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Billing — see docs/BUILD-PLAN.md for the owning slice. */
export default function BillingScreen() {
  return (
    <Page title="Billing">
      <EmptyState title="Billing" body="This module is being built." />
    </Page>
  );
}
