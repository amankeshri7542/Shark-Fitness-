import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): MemberDetail — see docs/BUILD-PLAN.md for the owning slice. */
export default function MemberDetailScreen() {
  return (
    <Page title="MemberDetail">
      <EmptyState title="MemberDetail" body="This module is being built." />
    </Page>
  );
}
