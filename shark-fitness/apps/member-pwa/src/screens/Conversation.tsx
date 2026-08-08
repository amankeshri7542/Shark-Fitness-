import { ScreenBody, Stack } from '../ui/shell';
import { EmptyState } from '../ui/primitives';

/** TODO(screen): Conversation — see docs/BUILD-PLAN.md for the owning slice. */
export default function ConversationScreen() {
  return (
    <ScreenBody>
      <Stack>
        <EmptyState
          title="Conversation"
          body="This screen is being built."
        />
      </Stack>
    </ScreenBody>
  );
}
