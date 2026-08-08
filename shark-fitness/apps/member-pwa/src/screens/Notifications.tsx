import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Notifications — see docs/BUILD-PLAN.md for the owning slice. */
export default function NotificationsScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Notifications"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
