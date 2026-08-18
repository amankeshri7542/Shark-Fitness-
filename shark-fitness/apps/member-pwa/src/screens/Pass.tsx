import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy } from '../lib/store';
import { useOnline } from '../lib/realtime';
import {
  Bar,
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
  SonarSweep,
  cx,
} from '../ui/primitives';

interface SignedPass {
  token: string;
  window: number;
  validFrom: number;
  expiresAt: number;
}

interface PassPayload {
  member: { name: string; memberNo: string; initials: string };
  branch: { id: string; name: string; timezone: string };
  code: {
    rotateSec: number;
    serverEpoch: number;
    passes: SignedPass[];
  };
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
  const [tick, setTick] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pass'],
    queryFn: () => api<PassPayload>('/member/pass'),
    staleTime: 30_000,
    refetchInterval: online ? 4 * 60_000 : false,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const checkOut = useMutation({
    mutationFn: () => api<{ minutesInside: number }>('/member/pass/check-out', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pass'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  const epoch = (data?.code.serverEpoch ?? 0) + tick;
  const activePass = useMemo(
    () => data?.code.passes.find((pass) => epoch >= pass.validFrom && epoch < pass.expiresAt) ?? null,
    [data?.code.passes, epoch],
  );
  const remaining = activePass ? Math.max(0, activePass.expiresAt - epoch) : 0;
  const lastPassExpiry = data?.code.passes.at(-1)?.expiresAt ?? 0;
  const batchExpired = Boolean(data && epoch >= lastPassExpiry);

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

        <Panel tone="accent" className="relative overflow-hidden p-4">
          <SonarSweep durationSec={2.8} />
          {activePass ? (
            <SignedPassBlock token={activePass.token} />
          ) : (
            <div className="grid aspect-square w-full place-items-center border border-line bg-abyss/70 p-6 text-center">
              <div>
                <Display size="sm" as="h2">Pass expired</Display>
                <p className="mt-2 text-[12px] leading-relaxed text-foam-50">
                  Reconnect once to load a fresh signed pass batch.
                </p>
              </div>
            </div>
          )}

          <div className="mt-3.5 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-utility text-[16px] font-semibold">
                {data.member.name} · {data.member.memberNo}
              </div>
              <div className="mt-0.5 text-[11px] text-foam-50">
                {online ? 'Signed pass' : 'Offline batch'} · {activePass ? `rotates in ${remaining}s` : 'refresh required'}
              </div>
            </div>
            <div className="text-right font-display text-[13px] tracking-[0.1em] text-sonar">
              {activePass ? shortCode(activePass.token) : '—'}
            </div>
          </div>

          <Bar className="mt-2" value={remaining} max={data.code.rotateSec} height="h-[3px]" />
        </Panel>

        {batchExpired ? (
          <Panel tone="warn" className="p-3">
            <p className="text-[12px] leading-relaxed text-foam-80">
              The offline pass batch has expired. Connect briefly and refresh before using the door.
            </p>
            <Button className="mt-3" variant="outline" size="sm" onClick={() => void refetch()} disabled={!online}>
              Refresh passes
            </Button>
          </Panel>
        ) : !online ? (
          <Panel tone="warn" className="p-3">
            <p className="text-[12px] leading-relaxed text-foam-80">
              You are offline. The signed passes already stored on this device continue rotating until the batch expires.
            </p>
          </Panel>
        ) : null}

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
              Show this signed pass to the gym reader. The reader verifies the signature and records the check-in; this phone cannot approve its own entry.
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

function shortCode(token: string): string {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, '0').slice(0, 7);
}

const PASS_GRID_SIZE = 25;

function isFinderCell(row: number, col: number, row0: number, col0: number): boolean {
  const y = row - row0;
  const x = col - col0;
  if (x < 0 || y < 0 || x > 6 || y > 6) return false;
  return x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
}

/**
 * Deterministic fill for the pass grid: the same token always draws the same
 * block, so the visual is stable across re-renders without being random.
 *
 * This lives outside the component because the xorshift step reassigns `state`
 * while mapping, which is not something a render pass may do. Same arithmetic,
 * same output — only the scope changed.
 */
export function passCells(token: string, size: number = PASS_GRID_SIZE): boolean[] {
  let state = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    state ^= token.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }

  return Array.from({ length: size * size }, (_, index) => {
    const row = Math.floor(index / size);
    const col = index % size;
    if (
      isFinderCell(row, col, 1, 1) ||
      isFinderCell(row, col, 1, size - 8) ||
      isFinderCell(row, col, size - 8, 1)
    ) {
      return true;
    }
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 2 === 0;
  });
}

/**
 * Visual transport for the signed token. It deliberately does not pretend to
 * be a standards-compliant QR encoder; native reader integration can replace
 * this component without changing the signed-token protocol.
 */
function SignedPassBlock({ token }: { token: string }) {
  const size = PASS_GRID_SIZE;
  const cells = useMemo(() => passCells(token, size), [token, size]);

  return (
    <div
      className="grid aspect-square w-full border-[10px] border-foam bg-foam"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      role="img"
      aria-label={`Rotating signed entry pass ${shortCode(token)}`}
    >
      {cells.map((filled, index) => (
        <span key={index} className={filled ? 'bg-abyss' : 'bg-foam'} />
      ))}
    </div>
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
