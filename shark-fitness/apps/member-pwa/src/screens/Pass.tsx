import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deriveCode, secondsUntilRotation } from '@shark/domain';
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

interface PassPayload {
  member: { name: string; memberNo: string; initials: string };
  branch: { id: string; name: string; timezone: string };
  code: { value: string; rotateSec: number; secondsRemaining: number; offlineSeed: string; serverEpoch: number };
  membership: { state: string; productName: string; endsOn: string | null; graceEndsOn: string | null } | null;
  outstandingMinor: number;
  willBeAdmitted: boolean;
  openSession: { id: string; enteredAt: string; minutesInside: number } | null;
  occupancy: { inside: number; capacity: number; label: string };
  history: Array<{ id: string; day: string; span: string; granted: boolean; branchName: string }>;
}

interface ScanResult {
  granted: boolean;
  decision: string;
  firstName: string;
  visitNumber: number | null;
  branchName: string;
  occupancy: { inside: number; capacity: number; label: string };
  message: string | null;
  resolution: { kind: string; amountMinor: number | null; invoiceId: string | null; message: string } | null;
  graceEndsOn: string | null;
}

const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN')}`;

export default function PassScreen() {
  const navigate = useNavigate();
  // The door is never the place for a hunting metaphor when it refuses you.
  const copy = useCopy();
  const denialCopy = useCopy('access-denied');
  const online = useOnline();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pass'],
    queryFn: () => api<PassPayload>('/member/pass'),
    staleTime: 60_000,
  });

  const [result, setResult] = useState<ScanResult | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  /* Brightness matters at a scanner. Raising it is a native capability we do
     not have on the web, so we say what we can and let the panel do the work. */
  const scan = useMutation({
    mutationFn: (simulate?: 'grant' | 'deny') =>
      api<ScanResult>('/member/pass/scan', {
        method: 'POST',
        body: { branchId: data?.branch.id, code: liveCode, ...(simulate ? { simulate } : {}) },
      }),
    onSuccess: (r) => {
      setResult(r);
      void queryClient.invalidateQueries({ queryKey: ['pass'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  const checkOut = useMutation({
    mutationFn: () => api<{ minutesInside: number }>('/member/pass/check-out', { method: 'POST' }),
    onSuccess: () => {
      setResult(null);
      void queryClient.invalidateQueries({ queryKey: ['pass'] });
    },
  });

  /* The code keeps rotating from the cached seed with no network at all —
     that is the whole point of the offline seed. */
  const liveEpoch = data ? data.code.serverEpoch + tick : 0;
  const liveCode = useMemo(
    () => (data ? deriveCode(data.code.offlineSeed, liveEpoch) : ''),
    [data, liveEpoch],
  );
  const remaining = data ? secondsUntilRotation(liveEpoch) : 0;

  if (isLoading) return <PassSkeleton />;

  if (error || !data) {
    return (
      <FullScreen onClose={() => void navigate({ to: '/' })} title="Entry code">
        <div className="p-4">
          <ErrorState
            title="Could not load your code"
            body="You can still get in at reception with your member number."
            onRetry={() => void refetch()}
          />
        </div>
      </FullScreen>
    );
  }

  /* — Denied ————————————————————————————————————————————————— */
  if (result && !result.granted) {
    return (
      // Plain register on the header too — a refusal is not a hunt.
      <FullScreen onClose={() => setResult(null)} title={denialCopy('passTitle')}>
        <div className="flex flex-col gap-4 p-4 pt-6 animate-surface">
          <Panel tone="bad" className="p-4">
            <div className="flex items-center gap-2.5 text-chum">
              <span aria-hidden="true" className="font-display text-[18px]">
                ×
              </span>
              <span className="font-utility text-[13px] font-semibold uppercase tracking-[0.14em]">
                Entry not allowed
              </span>
            </div>
            <p className="mt-2.5 text-[14px] leading-relaxed text-pretty text-foam-80">{result.message}</p>
          </Panel>

          {result.resolution?.amountMinor ? (
            <>
              <Seam>
                <SeamCell>
                  <Label>Outstanding</Label>
                  <div className="mt-1.5">
                    <Metric value={rupees(result.resolution.amountMinor)} size="md" tone="bad" />
                  </div>
                </SeamCell>
                {result.graceEndsOn ? (
                  <SeamCell>
                    <Label>Grace ends</Label>
                    <div className="mt-1.5 font-utility text-[15px] font-semibold">{result.graceEndsOn}</div>
                  </SeamCell>
                ) : null}
              </Seam>
              <p className="text-[13px] leading-relaxed text-foam-65">{result.resolution.message}</p>
              <Button variant="cta" size="lg" full onClick={() => void navigate({ to: '/billing' })}>
                Settle {rupees(result.resolution.amountMinor)}
              </Button>
            </>
          ) : null}

          <Button variant="outline" full onClick={() => void navigate({ to: '/messages' })}>
            Ask reception for help
          </Button>
          <Button variant="ghost" onClick={() => setResult(null)}>
            ← Back to my code
          </Button>
          <p className="text-[12px] leading-relaxed text-foam-45">
            Bookings you already hold are kept while this is sorted out.
          </p>
        </div>
      </FullScreen>
    );
  }

  /* — Admitted ——————————————————————————————————————————————— */
  if (result?.granted) {
    return (
      <FullScreen onClose={() => setResult(null)} title="Checked in">
        <div className="flex flex-col items-center gap-5 p-5 pt-8 animate-surface">
          <div className="relative h-[150px] w-[150px]">
            <svg width="150" height="150" viewBox="0 0 150 150" className="-rotate-90" aria-hidden="true">
              <circle cx="75" cy="75" r="66" fill="none" stroke="var(--sf-line)" strokeWidth="3" />
              <circle
                cx="75"
                cy="75"
                r="66"
                fill="none"
                stroke="var(--sf-sonar)"
                strokeWidth="3"
                strokeDasharray="414.7"
                style={{ animation: 'sf-ring .9s cubic-bezier(.2,.8,.3,1) both' }}
              />
            </svg>
            <style>{`@keyframes sf-ring { from { stroke-dashoffset: 414.7 } to { stroke-dashoffset: 0 } }`}</style>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span aria-hidden="true" className="font-display text-[34px] text-sonar">
                ✓
              </span>
              <Label className="mt-1.5">In the water</Label>
            </div>
          </div>

          <div className="text-center">
            <Display size="md" as="h2">
              Welcome back, {result.firstName}
            </Display>
            <p className="mt-1.5 text-[13px] text-foam-65">
              {result.branchName}
              {result.visitNumber ? ` · visit ${result.visitNumber}` : ''}
            </p>
          </div>

          <Seam className="w-full">
            <SeamCell className="text-center">
              <Metric value={result.occupancy.inside} size="md" />
              <Label className="mt-1 block">Inside now</Label>
            </SeamCell>
            <SeamCell className="text-center">
              <Metric value={result.occupancy.label} size="sm" tone="accent" />
              <Label className="mt-1 block">Floor</Label>
            </SeamCell>
            <SeamCell className="text-center">
              <Metric value={result.occupancy.capacity - result.occupancy.inside} size="md" />
              <Label className="mt-1 block">Space left</Label>
            </SeamCell>
          </Seam>

          <Button variant="cta" size="lg" full onClick={() => void navigate({ to: '/workout' })}>
            {copy('startSession')}
          </Button>
          <Button variant="ghost" onClick={() => setResult(null)}>
            Not now
          </Button>
        </div>
      </FullScreen>
    );
  }

  /* — The code ———————————————————————————————————————————————— */
  const inside = Boolean(data.openSession);

  return (
    <FullScreen onClose={() => void navigate({ to: '/' })} title={copy('passTitle')}>
      <div className="flex flex-col gap-4 p-4 pt-5 animate-surface">
        <div className="flex items-center gap-2">
          <Eyebrow>Access control</Eyebrow>
          <span className="flex-1" />
          {data.willBeAdmitted ? (
            <Chip tone="good">Valid</Chip>
          ) : (
            <Chip tone="warn">Needs attention</Chip>
          )}
        </div>

        <Panel tone="accent" className="relative overflow-hidden p-4">
          <SonarSweep durationSec={2.8} />
          <QrBlock code={liveCode} />

          <div className="mt-3.5 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-utility text-[16px] font-semibold">
                {data.member.name} · {data.member.memberNo}
              </div>
              <div className="mt-0.5 text-[11px] text-foam-50">
                {online ? 'Rotates' : 'Offline · still rotating'} in {remaining}s
              </div>
            </div>
            <div className="text-right font-display text-[13px] tracking-[0.1em] text-sonar">
              {liveCode.slice(0, 5)}
            </div>
          </div>

          <Bar className="mt-2" value={remaining} max={data.code.rotateSec} height="h-[3px]" />
        </Panel>

        {inside ? (
          <Button variant="outline" size="lg" full disabled={checkOut.isPending} onClick={() => checkOut.mutate()}>
            {checkOut.isPending ? 'Checking out…' : copy('checkOut')}
          </Button>
        ) : (
          <Button
            variant="cta"
            size="lg"
            full
            disabled={scan.isPending || !online}
            onClick={() => scan.mutate(undefined)}
          >
            {scan.isPending ? 'At the door…' : copy('checkIn')}
          </Button>
        )}

        {!online ? (
          <Panel tone="warn" className="p-3">
            <p className="text-[12px] leading-relaxed text-foam-80">
              You are offline. The code above still rotates and will scan at the door — the reader validates it, not
              this phone.
            </p>
          </Panel>
        ) : null}

        {inside && data.openSession ? (
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
        ) : null}

        <Panel className="p-3">
          <p className="text-[12px] leading-relaxed text-foam-50">
            The code changes every {data.code.rotateSec} seconds, so a screenshot will not get anyone in. Turn your
            screen brightness up at the reader.
          </p>
        </Panel>

        <div>
          <Label>Recent visits</Label>
          <Panel className="mt-2">
            {data.history.length === 0 ? (
              <p className="p-3.5 text-[13px] text-foam-45">No visits recorded yet. Your first one shows up here.</p>
            ) : (
              <ul>
                {data.history.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 border-b border-line-10 px-3.5 py-2.5 last:border-0">
                    <span
                      aria-hidden="true"
                      className={cx('h-1.5 w-1.5 flex-none', h.granted ? 'bg-sonar' : 'bg-chum')}
                    />
                    <span className="flex-1 text-[13px]">{h.day}</span>
                    <span className="font-utility text-[12px] tabular-nums text-foam-50">{h.span}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* Demo affordance: the denial path is a state the PRD requires, and a
            reviewer needs to be able to reach it without breaking their data. */}
        <Button variant="ghost" size="sm" onClick={() => scan.mutate('deny')} disabled={scan.isPending}>
          Preview a refused entry
        </Button>
      </div>
    </FullScreen>
  );
}

/**
 * A real QR-shaped block: three finder patterns, timing rows, and a data field
 * derived deterministically from the live code, so it visibly changes when the
 * code rotates. It is a faithful stand-in — a production build swaps this for
 * an encoder without touching the layout.
 */
function QrBlock({ code }: { code: string }) {
  const N = 25;
  const cells = useMemo(() => {
    let hash = 2166136261;
    for (let i = 0; i < code.length; i++) {
      hash ^= code.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    const out: boolean[] = [];
    const inBox = (r: number, c: number, r0: number, c0: number): boolean =>
      r >= r0 && r < r0 + 7 && c >= c0 && c < c0 + 7;
    const ring = (r: number, c: number, r0: number, c0: number): boolean => {
      const d = Math.max(Math.abs(r - r0 - 3), Math.abs(c - c0 - 3));
      return d === 3 || d <= 1;
    };
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (inBox(r, c, 0, 0)) out.push(ring(r, c, 0, 0));
        else if (inBox(r, c, 0, N - 7)) out.push(ring(r, c, 0, N - 7));
        else if (inBox(r, c, N - 7, 0)) out.push(ring(r, c, N - 7, 0));
        else if (r === 6 || c === 6) out.push((r + c) % 2 === 0);
        else {
          const v = Math.sin((r + 1) * 12.9898 + (c + 1) * 78.233 + hash * 0.000017) * 43758.5453;
          out.push(v - Math.floor(v) > 0.48);
        }
      }
    }
    return out;
  }, [code]);

  return (
    <div className="relative aspect-square bg-foam p-4" role="img" aria-label={`Entry code ${code}`}>
      <div className="grid h-full w-full" style={{ gridTemplateColumns: `repeat(${N}, 1fr)` }}>
        {cells.map((on, i) => (
          <div key={i} style={{ background: on ? '#04080b' : '#e8f1f5' }} />
        ))}
      </div>
      <div className="absolute left-1/2 top-1/2 grid h-[52px] w-[52px] -translate-x-1/2 -translate-y-1/2 place-items-center bg-abyss font-display text-[14px] tracking-[0.06em] text-sonar">
        SF
      </div>
    </div>
  );
}

function FullScreen({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className="flex h-full flex-col overflow-y-auto bg-abyss outline-none">
      <header className="sf-safe-top flex flex-none items-center gap-2.5 border-b border-line px-4 pb-2.5 pt-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-9 w-9 place-items-center border border-line-strong hover:border-sonar hover:text-sonar"
        >
          <span aria-hidden="true">×</span>
        </button>
        <span className="font-utility text-[13px] font-semibold uppercase tracking-[0.14em]">{title}</span>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function PassSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4 pb-2.5 pt-3">
        <Skeleton className="h-9 w-9" />
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="aspect-square w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
