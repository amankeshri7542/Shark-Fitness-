import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Challenge — see docs/BUILD-PLAN.md for the owning slice. */
export default function ChallengeScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Challenge"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
