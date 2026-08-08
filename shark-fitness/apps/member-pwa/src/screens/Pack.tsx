import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy } from '../lib/store';
import { ScreenBody, Stack, Surface } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Eyebrow,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  SectionRule,
  Skeleton,
  cx,
} from '../ui/primitives';

interface BoardRow {
  rank: number;
  memberId: string | null;
  displayName: string;
  initials: string;
  score: number;
  isYou: boolean;
  isPrivate: boolean;
  flagged: boolean;
}

interface Challenge {
  id: string;
  name: string;
  description: string;
  metricLabel: string;
  fairnessNote: string;
  daysLeft: number;
  teamMode: boolean;
  teamName: string | null;
  teamTarget: number | null;
  teamProgress: number | null;
  teamShort: number | null;
  teamProgressPct: number | null;
  participantCount: number;
  joined: boolean;
  anonymous: boolean;
  myScore: number | null;
  myRank: number | null;
  rewardLabel: string | null;
  lateJoinNote: string | null;
  board: BoardRow[];
}

interface Referral {
  code: string;
  target: number;
  invited: number;
  joined: number;
  pendingRewardMinor: number;
  earnedRewardMinor: number;
  shareMessage: string;
  rewardNote: string;
  invitees: Array<{ name: string; state: string; at: string }>;
}

interface EngagementPayload {
  fairnessNote: string;
  level: { level: number; name: string; progressPct: number; xpIntoLevel: number; xpForNextLevel: number; nextName: string | null };
  streak: { current: number; longest: number; thisWeek: number; weeklyTarget: number; week: boolean[]; restNote: string };
  achievements: Array<{ id: string; name: string; description: string; tier: string; earnedAt: string | null; progressPct: number }>;
  achievementsEarned: number;
  achievementsTotal: number;
  challenges: Challenge[];
  referral: Referral;
}

interface FeedPost {
  id: string;
  authorName: string;
  authorInitials: string;
  authorKind: 'member' | 'staff' | 'gym';
  isMine: boolean;
  kind: string;
  badge: string | null;
  body: string;
  removed: boolean;
  removedNote: string | null;
  relativeTime: string;
  kudos: number;
  kudosByMe: boolean;
  commentCount: number;
}

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN')}`;

export default function PackScreen() {
  const copy = useCopy();
  const queryClient = useQueryClient();
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const engagement = useQuery({
    queryKey: ['pack'],
    queryFn: () => api<EngagementPayload>('/member/engagement'),
  });

  const feed = useQuery({
    queryKey: ['pack', 'feed'],
    queryFn: () => api<{ items: FeedPost[] }>('/member/engagement/feed'),
  });

  const refreshFeed = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['pack'] });
  };

  const kudos = useMutation({
    mutationFn: (input: { id: string; on: boolean }) =>
      api(`/member/engagement/feed/${input.id}/kudos`, { method: input.on ? 'POST' : 'DELETE' }),
    onSuccess: refreshFeed,
  });

  const post = useMutation({
    mutationFn: (body: string) => api('/member/engagement/feed', { method: 'POST', body: { body } }),
    onSuccess: () => {
      setDraft('');
      setComposerOpen(false);
      refreshFeed();
    },
  });

  const report = useMutation({
    mutationFn: (id: string) =>
      api('/member/engagement/report', { method: 'POST', body: { targetType: 'post', targetId: id, reason: 'other' } }),
    onSuccess: refreshFeed,
  });

  if (engagement.isLoading) return <PackSkeleton />;

  if (engagement.error || !engagement.data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load the pack"
            body="Your own progress is unaffected."
            onRetry={() => void engagement.refetch()}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const d = engagement.data;
  const challenge = d.challenges[0] ?? null;

  return (
    <ScreenBody>
      <Surface>
        <Stack>
          <div>
            <Eyebrow>The pack</Eyebrow>
            <Display size="lg" className="mt-1.5">
              {copy('packTitle')}
            </Display>
          </div>

          {/* Level and streak */}
          <Seam>
            <SeamCell>
              <Label>Apex tier</Label>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <Metric value={d.level.level} size="md" tone="accent" />
                <span className="text-[12px] text-sonar">{d.level.name}</span>
              </div>
              <Bar className="mt-2" value={d.level.progressPct} height="h-[3px]" />
              <p className="mt-1.5 text-[11px] text-foam-50">
                {d.level.nextName
                  ? `${d.level.xpIntoLevel.toLocaleString('en-IN')} / ${d.level.xpForNextLevel.toLocaleString('en-IN')} to ${d.level.nextName}`
                  : 'Top tier'}
              </p>
            </SeamCell>
            <SeamCell>
              <Label>{copy('streakLabel')}</Label>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <Metric value={d.streak.current} size="md" />
                <span className="text-[11px] text-foam-45">best {d.streak.longest}</span>
              </div>
              <div className="mt-2 flex gap-1" aria-hidden="true">
                {d.streak.week.map((done, i) => (
                  <span key={i} className={cx('h-3 flex-1 border', done ? 'border-sonar bg-sonar' : 'border-line')} />
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-foam-50">
                {d.streak.thisWeek} of {d.streak.weeklyTarget} this week
              </p>
            </SeamCell>
          </Seam>

          {d.streak.restNote ? (
            <p className="-mt-1.5 text-[11px] leading-relaxed text-foam-35">{d.streak.restNote}</p>
          ) : null}

          {/* Challenge */}
          {challenge ? (
            <div>
              <SectionRule
                action={
                  <Link to="/pack/challenge/$challengeId" params={{ challengeId: challenge.id }}>
                    <Button variant="ghost" size="sm">
                      Rules
                    </Button>
                  </Link>
                }
              >
                {copy('challengeTitle')}
              </SectionRule>

              <Panel tone="accent" className="p-3.5">
                <div className="flex items-center gap-2">
                  <span className="font-display text-[15px] tracking-[0.06em] text-sonar">{challenge.name}</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-foam-50">{challenge.daysLeft} days left</span>
                </div>

                {challenge.teamMode && challenge.teamTarget ? (
                  <>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-foam-65">
                      Team target {challenge.teamTarget} {challenge.metricLabel}.
                      {challenge.teamShort && challenge.teamShort > 0
                        ? ` ${challenge.teamName ?? 'Your squad'} is ${challenge.teamShort} short.`
                        : ' Target met.'}
                    </p>
                    <Bar className="mt-2.5" value={challenge.teamProgressPct ?? 0} height="h-2" />
                  </>
                ) : (
                  <p className="mt-1.5 text-[13px] leading-relaxed text-foam-65">{challenge.description}</p>
                )}

                {challenge.lateJoinNote ? (
                  <p className="mt-2.5 border-t border-line pt-2.5 text-[11px] leading-relaxed text-foam-45">
                    {challenge.lateJoinNote}
                  </p>
                ) : null}
              </Panel>

              {/* Leaderboard */}
              <Panel className="mt-2.5">
                {challenge.board.map((row) => (
                  <div
                    key={`${row.rank}-${row.displayName}`}
                    className={cx(
                      'flex items-center gap-3 border-b border-line-10 px-3 py-2.5 last:border-0',
                      row.isYou && 'bg-wash-sonar',
                    )}
                  >
                    <span
                      className={cx(
                        'w-6 flex-none font-display text-[17px]',
                        row.isYou ? 'text-sonar' : 'text-foam-35',
                      )}
                    >
                      {row.rank}
                    </span>
                    <span className="grid h-7 w-7 flex-none place-items-center bg-[var(--sf-data-track)] font-utility text-[11px] font-semibold">
                      {row.isPrivate ? '··' : row.initials}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-utility text-[14px] font-semibold">
                      {row.displayName}
                      {row.isPrivate ? <span className="ml-1.5 text-[11px] font-normal text-foam-35">private</span> : null}
                    </span>
                    <span className="font-display text-[16px] tabular-nums">{row.score}</span>
                  </div>
                ))}
                {challenge.myRank && challenge.myRank > challenge.board.length ? (
                  <div className="flex items-center gap-3 border-t border-line bg-wash-sonar px-3 py-2.5">
                    <span className="w-6 flex-none font-display text-[17px] text-sonar">{challenge.myRank}</span>
                    <span className="min-w-0 flex-1 font-utility text-[14px] font-semibold">You</span>
                    <span className="font-display text-[16px] tabular-nums">{challenge.myScore}</span>
                  </div>
                ) : null}
              </Panel>

              {/* Fairness is stated in the open, not buried in terms. */}
              <p className="mt-2 text-[11px] leading-relaxed text-foam-45">{challenge.fairnessNote}</p>
            </div>
          ) : (
            <EmptyState
              title="No challenge running"
              body="Your gym runs these monthly. When the next one opens it shows up here."
            />
          )}

          {/* Referral */}
          <div>
            <SectionRule>Referral bounty</SectionRule>
            <Panel className="p-3.5">
              <p className="font-utility text-[15px] font-semibold">
                {d.referral.joined} of {d.referral.target} friends joined
                {d.referral.pendingRewardMinor > 0 ? ` · ${rupees(d.referral.pendingRewardMinor)} pending` : ''}
              </p>
              <div className="mt-3 flex gap-2">
                <div className="flex-1 border border-dashed border-line-strong px-3 py-2.5 text-center font-display text-[16px] tracking-[0.14em] text-sonar">
                  {d.referral.code}
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(d.referral.shareMessage);
                  }}
                >
                  Copy
                </Button>
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed text-foam-45">{d.referral.rewardNote}</p>
            </Panel>
          </div>

          {/* Achievements */}
          <div>
            <SectionRule>
              Achievements · {d.achievementsEarned} of {d.achievementsTotal}
            </SectionRule>
            <div className="grid grid-cols-2 gap-2">
              {d.achievements.slice(0, 6).map((a) => (
                <Panel key={a.id} className={cx('p-2.5', !a.earnedAt && 'opacity-55')}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-utility text-[12px] font-semibold">{a.name}</span>
                    {a.earnedAt ? <Chip tone="good" glyph={false}>✓</Chip> : null}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-foam-45">{a.description}</p>
                  {!a.earnedAt ? <Bar className="mt-1.5" value={a.progressPct} height="h-[3px]" /> : null}
                </Panel>
              ))}
            </div>
          </div>

          {/* Feed */}
          <div>
            <SectionRule
              action={
                <Button variant="ghost" size="sm" onClick={() => setComposerOpen((v) => !v)}>
                  {composerOpen ? 'Close' : 'Post'}
                </Button>
              }
            >
              Gym feed
            </SectionRule>

            {composerOpen ? (
              <Panel className="mb-2.5 p-3">
                <label htmlFor="post_body" className="sr-only">
                  Write a post
                </label>
                <textarea
                  id="post_body"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Share a session, a milestone, or a question for the gym."
                  className="sf-field resize-none"
                />
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    {draft.length}/500
                  </span>
                  <span className="flex-1" />
                  <Button
                    variant="cta"
                    size="sm"
                    disabled={draft.trim().length < 3 || post.isPending}
                    onClick={() => post.mutate(draft.trim())}
                  >
                    {post.isPending ? 'Posting…' : 'Post'}
                  </Button>
                </div>
              </Panel>
            ) : null}

            {feed.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !feed.data || feed.data.items.length === 0 ? (
              <EmptyState
                title="Nothing posted yet"
                body="This is your gym's own feed — members here, nobody else. Be the first to put something up."
              />
            ) : (
              <div className="flex flex-col gap-2.5">
                {feed.data.items.map((p) => (
                  <Panel key={p.id} className="p-3">
                    {p.removed ? (
                      <p className="text-[12px] italic leading-relaxed text-foam-45">
                        {p.removedNote ?? 'This post was removed by a moderator.'}
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cx(
                              'grid h-8 w-8 flex-none place-items-center border font-utility text-[11px] font-semibold',
                              p.authorKind === 'gym' ? 'border-line-accent text-sonar' : 'border-line-strong',
                            )}
                          >
                            {p.authorInitials}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px]">
                              {p.authorName}
                              {p.authorKind === 'gym' ? (
                                <span className="ml-1.5 text-[11px] text-foam-45">· announcement</span>
                              ) : null}
                            </div>
                            <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                              {p.relativeTime}
                            </div>
                          </div>
                          {p.badge ? <Chip tone="accent" glyph={false}>{p.badge}</Chip> : null}
                        </div>

                        <p className="mt-2.5 text-[14px] leading-relaxed text-pretty">{p.body}</p>

                        <div className="mt-2.5 flex items-center gap-3 border-t border-line-10 pt-2.5">
                          <button
                            type="button"
                            onClick={() => kudos.mutate({ id: p.id, on: !p.kudosByMe })}
                            className={cx(
                              'font-utility text-[11px] font-semibold uppercase tracking-[0.1em]',
                              p.kudosByMe ? 'text-sonar' : 'text-foam-50 hover:text-foam',
                            )}
                          >
                            <span aria-hidden="true">◆</span> {p.kudos} kudos
                          </button>
                          <span className="font-utility text-[11px] uppercase tracking-[0.1em] text-foam-45">
                            {p.commentCount} comment{p.commentCount === 1 ? '' : 's'}
                          </span>
                          <span className="flex-1" />
                          {!p.isMine ? (
                            <button
                              type="button"
                              onClick={() => report.mutate(p.id)}
                              className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35 hover:text-chum"
                            >
                              Report
                            </button>
                          ) : null}
                        </div>
                      </>
                    )}
                  </Panel>
                ))}
              </div>
            )}
          </div>
        </Stack>
      </Surface>
    </ScreenBody>
  );
}

function PackSkeleton() {
  return (
    <ScreenBody>
      <Stack>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-48 w-full" />
      </Stack>
    </ScreenBody>
  );
}
