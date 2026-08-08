import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Members — see docs/BUILD-PLAN.md for the owning slice. */
export default function MembersScreen() {
  return (
    <Page title="Members">
      <EmptyState title="Members" body="This module is being built." />
    </Page>
  );
}
