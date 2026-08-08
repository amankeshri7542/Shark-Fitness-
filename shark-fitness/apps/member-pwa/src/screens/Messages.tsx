import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Messages — see docs/BUILD-PLAN.md for the owning slice. */
export default function MessagesScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Messages"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
