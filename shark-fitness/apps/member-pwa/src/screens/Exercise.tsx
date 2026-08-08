import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Exercise — see docs/BUILD-PLAN.md for the owning slice. */
export default function ExerciseScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Exercise"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
