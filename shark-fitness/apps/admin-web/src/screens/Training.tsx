import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Training — see docs/BUILD-PLAN.md for the owning slice. */
export default function TrainingScreen() {
  return (
    <Page title="Training">
      <EmptyState title="Training" body="This module is being built." />
    </Page>
  );
}
