import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Settings — see docs/BUILD-PLAN.md for the owning slice. */
export default function SettingsScreen() {
  return (
    <Page title="Settings">
      <EmptyState title="Settings" body="This module is being built." />
    </Page>
  );
}
