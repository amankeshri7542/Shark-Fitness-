import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Staff — see docs/BUILD-PLAN.md for the owning slice. */
export default function StaffScreen() {
  return (
    <Page title="Staff">
      <EmptyState title="Staff" body="This module is being built." />
    </Page>
  );
}
