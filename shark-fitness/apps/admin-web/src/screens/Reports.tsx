import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Reports — see docs/BUILD-PLAN.md for the owning slice. */
export default function ReportsScreen() {
  return (
    <Page title="Reports">
      <EmptyState title="Reports" body="This module is being built." />
    </Page>
  );
}
