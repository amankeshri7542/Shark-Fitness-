import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Library — see docs/BUILD-PLAN.md for the owning slice. */
export default function LibraryScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Library"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
