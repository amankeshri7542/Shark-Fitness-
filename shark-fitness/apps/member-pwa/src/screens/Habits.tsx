import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Habits — see docs/BUILD-PLAN.md for the owning slice. */
export default function HabitsScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Habits"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
