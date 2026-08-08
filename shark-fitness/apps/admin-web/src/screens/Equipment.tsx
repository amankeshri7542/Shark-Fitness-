import { Page } from '../ui/shell';
import { EmptyState } from '../ui/console';

/** TODO(screen): Equipment — see docs/BUILD-PLAN.md for the owning slice. */
export default function EquipmentScreen() {
  return (
    <Page title="Equipment">
      <EmptyState title="Equipment" body="This module is being built." />
    </Page>
  );
}
