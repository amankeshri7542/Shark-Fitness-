import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy } from '../lib/store';
import { useOnline } from '../lib/realtime';
import {
  Button,
  Chip,
  Display,
  ErrorState,
  Eyebrow,
  Label,
  Metric,
  Panel,
  Seam,
  SeamCell,
  Skeleton,
  cx,
} from '../ui/primitives';

interface PassPayload {
  member: { name: string; memberNo: string; initials: string };
  branch: { id: string; name: string; timezone: string };
  membership: { state: string; productName: string; endsOn: string | null; graceEndsOn: string | null } | null;
  outstandingMinor: number;
  willBeAdmitted: boolean;
  openSession: { id: string; enteredAt: string; minutesInside: number } | null;
  occupancy: { inside: number; capacity: number; label: string };
  history: Array<{ id: string; day: string; span: string; granted: boolean; branchName: string }>;
}

export default function PassScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useCopy();
  const online = useOnline();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pass'],
    queryFn: () => api<PassPayload>('/member/pass'),
    staleTime: 30_000,
    refetchInterval: online ? 4 * 60_000 : false,
  });

  const checkOut = useMutation({
    mutationFn: () => api<{ minutesInside: number }>('/member/pass/check-out', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pass'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  if (isLoading) return <PassSkeleton />;

  if (error || !data) {
    return (
      <FullScreen onClose={() => void navigate({ to: '/' })} title="Entry pass">
        <div className="p-4">
          <ErrorState
            title="Could not load your pass"
            body="Reception can still find you by your member number."
            onRetry={() => void refetch()}
          />
        </div>
      </FullScreen>
    );
  }

  return (
    <FullScreen onClose={() => void navigate({ to: '/' })} title={copy('passTitle')}>
      <div className="flex flex-col gap-4 p-4 pt-5 animate-surface">
        <div className="flex items-center gap-2">
          <Eyebrow>Access control</Eyebrow>
          <span className="flex-1" />
          {data.willBeAdmitted ? <Chip tone="good">Eligible</Chip> : <Chip tone="warn">Needs attention</Chip>}
        </div>

        <Panel tone="accent" className="p-4">
          <Label>Reception check-in</Label>
          <Display size="sm" as="h2">{data.member.memberNo}</Display>
          <p className="mt-2 text-[16px]">{data.member.name}</p>
          <p className="mt-3 text-[13px] text-foam-65">
            Show your member number to reception. Staff verify your membership and record attendance.
            This card is not a QR code or door credential.
          </p>
          {!online ? <p role="status" className="mt-3 text-[13px] text-flare">Offline: this information may be out of date. Reception must verify access.</p> : null}
        </Panel>

        {data.openSession ? (
          <>
            <Seam>
              <SeamCell>
                <Label>Inside for</Label>
                <div className="mt-1.5">
                  <Metric value={data.openSession.minutesInside} unit="min" size="md" />
                </div>
              </SeamCell>
              <SeamCell>
                <Label>Floor now</Label>
                <div className="mt-1.5">
                  <Metric value={`${data.occupancy.inside}/${data.occupancy.capacity}`} size="sm" tone="accent" />
                </div>
              </SeamCell>
            </Seam>
            <Button
              variant="outline"
              size="lg"
              full
              disabled={checkOut.isPending}
              onClick={() => checkOut.mutate()}
            >
              {checkOut.isPending ? 'Checking out…' : copy('checkOut')}
            </Button>
          </>
        ) : (
          <Panel className="p-3.5">
            <Label>At the door</Label>
            <p className="mt-1.5 text-[13px] leading-relaxed text-foam-65">
              Ask reception to check you in. Door scanning is not available in this offering.
            </p>
          </Panel>
        )}

        <Seam>
          <SeamCell>
            <Label>Membership</Label>
            <div className="mt-1.5 font-utility text-[14px] font-semibold">
              {data.membership?.productName ?? 'No active plan'}
            </div>
          </SeamCell>
          <SeamCell>
            <Label>Floor</Label>
            <div className="mt-1.5">
              <Metric value={data.occupancy.label} size="sm" tone="accent" />
            </div>
          </SeamCell>
        </Seam>

        <div>
          <Label>Recent visits</Label>
          <Panel className="mt-2">
            {data.history.length === 0 ? (
              <p className="p-3.5 text-[13px] text-foam-45">No visits recorded yet. Your first one shows up here.</p>
            ) : (
              <ul>
                {data.history.map((visit) => (
                  <li key={visit.id} className="flex items-center gap-3 border-b border-line-10 px-3.5 py-2.5 last:border-0">
                    <span
                      aria-hidden="true"
                      className={cx('h-1.5 w-1.5 flex-none', visit.granted ? 'bg-sonar' : 'bg-chum')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px]">{visit.day}</span>
                      <span className="block truncate text-[10px] text-foam-35">{visit.branchName}</span>
                    </span>
                    <span className="font-utility text-[12px] tabular-nums text-foam-50">{visit.span}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </FullScreen>
  );
}

function FullScreen({ onClose, title, children }: { onClose: () => void; title: string; children: ReactNode }) {
  return (
    <div className="min-h-full bg-abyss">
      <header className="sticky top-0 z-20 flex min-h-14 items-center border-b border-line bg-hull/95 px-3 backdrop-blur">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close entry pass"
          className="grid h-11 w-11 place-items-center border border-transparent text-sonar hover:border-line"
        >
          <span aria-hidden="true">×</span>
        </button>
        <span className="flex-1 text-center font-utility text-[11px] font-semibold uppercase tracking-[0.18em]">{title}</span>
        <span className="h-11 w-11" aria-hidden="true" />
      </header>
      {children}
    </div>
  );
}

function PassSkeleton() {
  return (
    <FullScreen onClose={() => undefined} title="Entry pass">
      <div className="flex flex-col gap-4 p-4 pt-5">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="aspect-square w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </FullScreen>
  );
}
