import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Book — see docs/BUILD-PLAN.md for the owning slice. */
export default function BookScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Book"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
