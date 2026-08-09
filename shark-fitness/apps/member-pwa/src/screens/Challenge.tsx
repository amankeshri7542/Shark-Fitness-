import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  ErrorState,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

/**
 * One challenge and its board.
 *
 * Two rules the server enforces and this screen must not undermine:
 *
 * 1. Some metrics are never ranked — volume lifted and body measurements do not
 *    go on a leaderboard. When `ranked` is false there is no board at all, and
 *    the reason is shown rather than an empty table.
 * 2. A private entrant keeps their rank but not their name, and the server does
 *    not send their member id. The board renders exactly what it is given; it
 *    never reconstructs an identity.
 */

interface BoardRow {
  rank: number;
  memberId: string | null;
  displayName: string;
  initials: string;
  score: number;
  rawCount: number;
  isYou: boolean;
  isPrivate: boolean;
  isBlocked: boolean;
  teamId: string | null;
  flagged: boolean;
}

interface Payload {
  challenge: {
    id: string;
    name: string;
    description: string;
    metricLabel: string;
    ranked: boolean;
    unrankedReason: string | null;
    fairnessNote: string;
    startsOn: string;
    endsOn: string;
    daysLeft: number;
    totalDays: number;
    daysElapsed: number;
    teamMode: boolean;
    teamName: string | null;
    teamTarget: number | null;
    teamProgress: number | null;
    teamProgressPct: number | null;
    participantCount: number;
    joined: boolean;
    anonymous: boolean;
    myScore: number | null;
    myRank: number | null;
    rules: string | null;
    rewardLabel: string | null;
  };
  board: BoardRow[];
  teams: Array<{ teamId: string; name: string; rawCount: number; members: number }>;
  privacyNote: string;
}

export default function ChallengeScreen() {
  const { challengeId } = useParams({ from: '/tabs/pack/challenge/$challengeId' });
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['challenge', challengeId],
    queryFn: () => api<Payload>(`/member/engagement/challenge/${challengeId}`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['challenge', challengeId] });
    void queryClient.invalidateQueries({ queryKey: ['pack'] });
  };

  const join = useMutation({
    mutationFn: () => api(`/member/engagement/challenge/${challengeId}/join`, { method: 'POST', body: {} }),
    onSuccess: invalidate,
  });

  const leave = useMutation({
    mutationFn: () => api(`/member/engagement/challenge/${challengeId}/leave`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-28" />
          <Skeleton className="h-16" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </Stack>
      </ScreenBody>
    );
  }

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load this challenge"
            body="Your score is safe on the server. Try again in a moment."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const { challenge, board, teams } = data;

  return (
    <ScreenBody>
      <Stack>
        <div>
          <Label>{challenge.metricLabel}</Label>
          <Display size="md" as="h1" className="mt-1">
            {challenge.name}
          </Display>
          <p className="mt-2 text-[13px] leading-relaxed text-foam-65">{challenge.description}</p>
        </div>

        <Seam>
          <SeamCell>
            <Label>Days left</Label>
            <div className="mt-1">
              <Metric value={challenge.daysLeft} size="md" tone={challenge.daysLeft <= 3 ? 'warn' : 'accent'} />
            </div>
          </SeamCell>
          <SeamCell>
            <Label>In it</Label>
            <div className="mt-1">
              <Metric value={challenge.participantCount} size="md" />
            </div>
          </SeamCell>
          {challenge.joined ? (
            <SeamCell>
              <Label>{challenge.ranked ? 'Your rank' : 'Your score'}</Label>
              <div className="mt-1">
                <Metric
                  value={challenge.ranked ? (challenge.myRank ?? '—') : (challenge.myScore ?? '—')}
                  size="md"
                  tone="accent"
                />
              </div>
            </SeamCell>
          ) : null}
        </Seam>

        <Bar value={challenge.daysElapsed} max={Math.max(1, challenge.totalDays)} tone="accent" />

        {challenge.joined ? (
          <Button variant="outline" full disabled={leave.isPending} onClick={() => leave.mutate()}>
            Leave challenge
          </Button>
        ) : (
          <Button variant="cta" full disabled={join.isPending} onClick={() => join.mutate()}>
            Join challenge
          </Button>
        )}

        {/* — Team ————————————————————————————————————————————— */}

        {challenge.teamMode && challenge.teamName ? (
          <>
            <SectionRule>{challenge.teamName}</SectionRule>
            <Panel className="flex flex-col gap-2 p-4">
              {challenge.teamTarget !== null && challenge.teamProgressPct !== null ? (
                <>
                  <Bar value={challenge.teamProgressPct} max={100} tone="good" />
                  <p className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">
                    {challenge.teamProgress} of {challenge.teamTarget}
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-foam-65">Your squad is in. No target set for this one.</p>
              )}
              {teams.length > 1 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {teams.map((team) => (
                    <div key={team.teamId} className="flex items-center gap-2">
                      <span className="w-20 flex-none truncate text-[12px]">{team.name}</span>
                      <span className="flex-1">
                        <Bar
                          value={team.rawCount}
                          max={Math.max(1, ...teams.map((t) => t.rawCount))}
                          tone={team.name === challenge.teamName ? 'accent' : 'neutral'}
                        />
                      </span>
                      <span className="w-10 flex-none text-right font-display text-[13px] tabular-nums">
                        {team.rawCount}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </Panel>
          </>
        ) : null}

        {/* — Board, or the reason there isn't one ————————————— */}

        <SectionRule>Board</SectionRule>

        {!challenge.ranked ? (
          <Panel className="flex flex-col gap-2 p-4">
            <Label>Not ranked</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{challenge.unrankedReason}</p>
          </Panel>
        ) : board.length === 0 ? (
          <Panel className="p-4">
            <p className="text-[13px] leading-relaxed text-foam-65">
              Nobody has scored yet. First one on the board sets the pace.
            </p>
          </Panel>
        ) : (
          <Panel className="flex flex-col">
            {board.map((row) => (
              <div
                key={`${row.rank}-${row.displayName}`}
                className={cx(
                  'flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0',
                  row.isYou && 'bg-wash-sonar',
                )}
              >
                <span className="w-6 flex-none font-display text-[16px] tabular-nums text-foam-45">{row.rank}</span>
                <span className="grid h-8 w-8 flex-none place-items-center border border-line-strong font-utility text-[10px] font-semibold">
                  {row.initials}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{row.displayName}</span>
                {row.isPrivate ? <Chip tone="neutral">Private</Chip> : null}
                {row.flagged ? <Chip tone="warn">Under review</Chip> : null}
                <span className="font-display text-[16px] tabular-nums">{row.score}</span>
              </div>
            ))}
          </Panel>
        )}

        {challenge.rewardLabel ? (
          <Panel tone="good" className="p-4">
            <Label>Reward</Label>
            <p className="mt-1 text-[13px] leading-relaxed text-foam-65">{challenge.rewardLabel}</p>
          </Panel>
        ) : null}

        {challenge.rules ? (
          <Panel className="p-4">
            <Label>Rules</Label>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foam-65">{challenge.rules}</p>
          </Panel>
        ) : null}

        {/* Both notes come from the server verbatim — fairness and privacy are
            promises, not paraphrase. */}
        <p className="text-[12px] leading-relaxed text-foam-50">{challenge.fairnessNote}</p>
        <p className="text-[12px] leading-relaxed text-foam-50">{data.privacyNote}</p>
      </Stack>
    </ScreenBody>
  );
}
