import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Store — see docs/BUILD-PLAN.md for the owning slice. */
export default function StoreScreen() {
  return (
    <Page title="Store">
      <EmptyState title="Store" body="This module is being built." />
    </Page>
  );
}
