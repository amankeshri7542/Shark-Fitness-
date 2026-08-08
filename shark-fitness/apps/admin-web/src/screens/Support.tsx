import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Support — see docs/BUILD-PLAN.md for the owning slice. */
export default function SupportScreen() {
  return (
    <Page title="Support">
      <EmptyState title="Support" body="This module is being built." />
    </Page>
  );
}
