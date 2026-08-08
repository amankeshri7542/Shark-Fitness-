import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Plans — see docs/BUILD-PLAN.md for the owning slice. */
export default function PlansScreen() {
  return (
    <Page title="Plans">
      <EmptyState title="Plans" body="This module is being built." />
    </Page>
  );
}
