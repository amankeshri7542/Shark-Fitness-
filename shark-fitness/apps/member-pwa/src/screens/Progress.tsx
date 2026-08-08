import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Progress — see docs/BUILD-PLAN.md for the owning slice. */
export default function ProgressScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Progress"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
