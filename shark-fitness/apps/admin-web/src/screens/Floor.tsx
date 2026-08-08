import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Floor — see docs/BUILD-PLAN.md for the owning slice. */
export default function FloorScreen() {
  return (
    <Page title="Floor">
      <EmptyState title="Floor" body="This module is being built." />
    </Page>
  );
}
