import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Summary — see docs/BUILD-PLAN.md for the owning slice. */
export default function SummaryScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Summary"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
