import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Panel,
  SectionRule,
  Segmented,
  Skeleton,
} from '../ui/primitives';

/**
 * On-demand library.
 *
 * This gym has no video streaming switched on, so the screen leads with that
 * fact once, at the top, and then gets on with being useful: what the session
 * is, who coaches it, how long it runs and what kit it needs. Every card would
 * otherwise have to apologise separately, which reads as broken rather than
 * honest.
 *
 * Favourites and progress still work, because they do not need a video
 * pipeline and they survive one being added later.
 */

interface Asset {
  id: string;
  title: string;
  category: string;
  trainerName: string;
  durationSec: number;
  durationLabel: string;
  level: string;
  equipment: string[];
  posterColor: string;
  hasCaptions: boolean;
  playbackUrl: string | null;
  playable: boolean;
  blockedReason: string | null;
  blockedMessage: string | null;
  positionSec: number;
  progressPct: number;
  favourite: boolean;
  completedAt: string | null;
}

interface Payload {
  streaming: { enabled: boolean; usedMinutes: number; limitMinutes: number; message: string | null };
  categories: Array<{ value: string; label: string; count: number }>;
  total: number;
  items: Asset[];
}

type Level = 'all' | 'beginner' | 'intermediate' | 'advanced';

export default function LibraryScreen() {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState('all');
  const [level, setLevel] = useState<Level>('all');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [search, setSearch] = useState('');

  const params = new URLSearchParams({ category, level });
  if (favouritesOnly) params.set('favourites', 'true');
  if (search.trim()) params.set('q', search.trim());

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['library', category, level, favouritesOnly, search.trim()],
    queryFn: () => api<Payload>(`/member/media?${params.toString()}`),
  });

  const favourite = useMutation({
    mutationFn: (input: { assetId: string; favourite: boolean }) =>
      api(`/member/media/${input.assetId}/progress`, { method: 'POST', body: { favourite: input.favourite } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['library'] }),
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-16" />
          <Skeleton className="h-11" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
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
            title="Could not load the library"
            body="The catalogue did not answer. Your saved sessions are safe."
            onRetry={() => void refetch()}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        </Stack>
      </ScreenBody>
    );
  }

  return (
    <ScreenBody>
      <Stack>
        {/* Said once, plainly, rather than on every card. */}
        {!data.streaming.enabled && data.streaming.message ? (
          <Panel tone="warn" className="flex flex-col gap-2 p-4">
            <Label>Streaming is off</Label>
            <p className="text-[13px] leading-relaxed text-foam-65">{data.streaming.message}</p>
          </Panel>
        ) : null}

        <Field
          label="Search"
          placeholder="Session or coach"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <Segmented
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: 'All' },
            { value: 'beginner', label: 'Easy' },
            { value: 'intermediate', label: 'Mid' },
            { value: 'advanced', label: 'Hard' },
          ]}
        />

        <div className="flex flex-wrap gap-2">
          {data.categories.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setCategory(c.value)}
              aria-pressed={category === c.value}
              className={
                category === c.value
                  ? 'min-h-9 border border-sonar bg-wash-sonar px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-sonar'
                  : 'min-h-9 border border-line px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-foam-50'
              }
            >
              {c.label} <span className="text-foam-35">{c.count}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFavouritesOnly((v) => !v)}
            aria-pressed={favouritesOnly}
            className={
              favouritesOnly
                ? 'min-h-9 border border-sonar bg-wash-sonar px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-sonar'
                : 'min-h-9 border border-line px-2.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-foam-50'
            }
          >
            Saved
          </button>
        </div>

        <SectionRule>{data.total === 0 ? 'Nothing found' : `${data.total} sessions`}</SectionRule>

        {data.items.length === 0 ? (
          <EmptyState
            title={favouritesOnly ? 'Nothing saved yet' : 'Nothing matches that'}
            body={
              favouritesOnly
                ? 'Save a session with the bookmark and it will be waiting here.'
                : 'Try a different level or clear the search.'
            }
          />
        ) : (
          data.items.map((asset) => (
            <Panel key={asset.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start gap-3">
                {/* The poster colour is the asset's own; with no thumbnail
                    pipeline it stands in as an identifier rather than decoration. */}
                <span
                  aria-hidden="true"
                  className="h-12 w-12 flex-none border border-line"
                  style={{ background: asset.posterColor }}
                />
                <div className="min-w-0 flex-1">
                  <Display size="sm" as="h3">
                    {asset.title}
                  </Display>
                  <p className="mt-1 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">
                    {asset.trainerName} · {asset.durationLabel} · {asset.level}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={asset.favourite ? `Remove ${asset.title} from saved` : `Save ${asset.title}`}
                  onClick={() => favourite.mutate({ assetId: asset.id, favourite: !asset.favourite })}
                >
                  {asset.favourite ? 'Saved' : 'Save'}
                </Button>
              </div>

              {asset.progressPct > 0 ? (
                <div>
                  <Bar value={asset.progressPct} max={100} tone="accent" />
                  <p className="mt-1 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
                    {asset.completedAt ? 'Finished' : `${asset.progressPct}% through`}
                  </p>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {asset.hasCaptions ? <Chip tone="neutral">Captions</Chip> : null}
                {asset.equipment.length > 0 ? (
                  <Chip tone="neutral">{asset.equipment.join(', ')}</Chip>
                ) : (
                  <Chip tone="good">No kit</Chip>
                )}
                {asset.completedAt ? <Chip tone="good">Done</Chip> : null}
              </div>

              {/* A control that cannot work is never shown as if it could. */}
              {asset.playable && asset.playbackUrl ? (
                <Button variant="cta" full onClick={() => window.open(asset.playbackUrl!, '_blank', 'noopener')}>
                  Play
                </Button>
              ) : asset.blockedReason === 'not_in_plan' ? (
                <Panel tone="warn" className="p-3">
                  <p className="text-[12px] leading-relaxed text-foam-65">{asset.blockedMessage}</p>
                </Panel>
              ) : (
                <p className="text-[12px] leading-relaxed text-foam-50">{asset.blockedMessage}</p>
              )}
            </Panel>
          ))
        )}
      </Stack>
    </ScreenBody>
  );
}
