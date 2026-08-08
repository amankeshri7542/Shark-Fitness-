import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Pass — see docs/BUILD-PLAN.md for the owning slice. */
export default function PassScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Pass"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
