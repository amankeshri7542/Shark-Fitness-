import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Platform — see docs/BUILD-PLAN.md for the owning slice. */
export default function PlatformScreen() {
  return (
    <Page title="Platform">
      <EmptyState title="Platform" body="This module is being built." />
    </Page>
  );
}
