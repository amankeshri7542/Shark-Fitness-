import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Pack — see docs/BUILD-PLAN.md for the owning slice. */
export default function PackScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Pack"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
