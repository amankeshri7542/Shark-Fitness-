import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Billing — see docs/BUILD-PLAN.md for the owning slice. */
export default function BillingScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Billing"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
