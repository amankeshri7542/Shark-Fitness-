import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Schedule — see docs/BUILD-PLAN.md for the owning slice. */
export default function ScheduleScreen() {
  return (
    <Page title="Schedule">
      <EmptyState title="Schedule" body="This module is being built." />
    </Page>
  );
}
