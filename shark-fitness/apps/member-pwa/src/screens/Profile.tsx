import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Profile — see docs/BUILD-PLAN.md for the owning slice. */
export default function ProfileScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Profile"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
