import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Train — see docs/BUILD-PLAN.md for the owning slice. */
export default function TrainScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Train"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
