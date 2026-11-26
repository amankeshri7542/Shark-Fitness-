import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCopy, useViewer } from '../lib/store';
import { useOnline } from '../lib/realtime';
import {
  REFRESH_WHEN_REMAINING,
  clockOffsetMs,
  codeOnScreen,
  rememberMemberNo,
  rememberedMemberNo,
  type PassCode,
} from '../lib/pass';
import { QrCode } from '../ui/QrCode';
import {
  Bar,
  Button,
  Chip,
  Display,
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

/**
 * Entry pass (UX-M03, PF-ATT-001/002/005).
 *
 * The rotating code reception scans. Everything on this screen is an access
 * moment, so it speaks in the plain register whatever the member's preference
 * (`useCopy('pass')`, PLAIN_ONLY_SURFACES). States:
 *
 * - active / grace: the QR, a countdown read through the server's clock, and
 *   a fresh run fetched before the current one runs out;
 * - frozen / expired / suspended / cancelled / not started: no code, the
 *   reason, and the one next step (Billing or reception);
 * - offline, or the refresh failed and the held code has lapsed: the member
 *   number, which reception can check in by hand.
 */

type PassState = 'active' | 'grace' | 'frozen' | 'expired' | 'suspended' | 'cancelled' | 'pending' | 'none';

export interface PassPayload {
  member: { name: string; memberNo: string; initials: string };
  branch: { id: string; name: string; timezone: string };
  branches: Array<{ id: string; name: string; home: boolean }>;
  state: PassState;
  notice: { title: string; body: string; action: 'billing' | 'reception' | null } | null;
  code: (PassCode & { serverTime?: string }) | null;
  membership: { state: string; productName: string; endsOn: string | null; graceEndsOn: string | null } | null;
  outstandingMinor: number;
  willBeAdmitted: boolean;
  openSession: { id: string; enteredAt: string; minutesInside: number } | null;
  occupancy: { inside: number; capacity: number; label: string };
  history: Array<{ id: string; day: string; span: string; granted: boolean; branchName: string }>;
}

/** Refetch cadence while the screen is open: half the six-window run. */
const REFRESH_MS = 90_000;

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useReducedMotion(): boolean {
  const preference = useViewer()?.preferences.reducedMotion ?? false;
  const [system, setSystem] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystem(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return preference || system;
}

/** Keeps the screen awake while a code is showing, so it does not dim in the
 *  queue at the desk. Re-acquired when the app comes back to the foreground. */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (!active || !nav.wakeLock) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock!
        .request('screen')
        .then((lock) => {
          if (cancelled) void lock.release();
          else sentinel = lock;
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

export default function PassScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useCopy('pass');
  const online = useOnline();
  const viewer = useViewer();
  const [branchId, setBranchId] = useState<string | null>(null);

  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['pass', branchId ?? 'default'],
    queryFn: () => api<PassPayload>(`/member/pass${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`),
    staleTime: 15_000,
    refetchInterval: online ? REFRESH_MS : false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  useEffect(() => {
    if (data && viewer) rememberMemberNo(viewer.userId, data.member.memberNo, data.member.name);
  }, [data, viewer]);

  const checkOut = useMutation({
    mutationFn: () => api<{ minutesInside: number }>('/member/pass/check-out', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pass'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });

  const close = () => void navigate({ to: '/' });
  const title = copy('passTitle');

  if (isLoading) return <PassSkeleton title={title} onClose={close} />;

  const card = data?.member ?? rememberedMemberNo(viewer?.userId);

  if (!data) {
    return (
      <FullScreen onClose={close} title={title}>
        <div className="flex flex-col gap-4 p-4 pt-5">
          <MemberNumberFallback
            memberNo={card?.memberNo ?? null}
            name={card?.name ?? viewer?.name ?? null}
            reason={online ? 'refresh' : 'offline'}
            onRetry={online || error ? () => void refetch() : undefined}
          />
        </div>
      </FullScreen>
    );
  }

  return (
    <FullScreen onClose={close} title={title}>
      <div className="flex flex-col gap-4 p-4 pt-5">
        <div className="flex items-center gap-2">
          <Eyebrow>Access</Eyebrow>
          <span className="flex-1" />
          {data.openSession ? (
            <Chip tone="good">Checked in</Chip>
          ) : data.code ? (
            <Chip tone={data.state === 'grace' ? 'warn' : 'good'}>{data.state === 'grace' ? 'Grace period' : 'Valid'}</Chip>
          ) : (
            <Chip tone="warn">No entry code</Chip>
          )}
        </div>

        {data.branches.length > 1 ? (
          <BranchPicker branches={data.branches} value={data.branch.id} onChange={setBranchId} />
        ) : null}

        {data.notice ? <StateNotice notice={data.notice} /> : null}

        {data.code ? (
          online ? (
            <LiveCode
              code={data.code}
              receivedAt={dataUpdatedAt}
              acquiring={isFetching}
              member={data.member}
              branchName={data.branch.name}
              refetch={() => void refetch()}
            />
          ) : (
            <MemberNumberFallback memberNo={data.member.memberNo} name={data.member.name} reason="offline" />
          )
        ) : (
          <MemberCard memberNo={data.member.memberNo} name={data.member.name} />
        )}

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
            <Button variant="outline" size="lg" full disabled={checkOut.isPending} onClick={() => checkOut.mutate()}>
              {checkOut.isPending ? 'Checking out…' : copy('checkOut')}
            </Button>
            {checkOut.isError ? (
              <p role="alert" className="text-[13px] text-chum">
                Could not check you out. Try again, or tell reception on your way out.
              </p>
            ) : null}
          </>
        ) : null}

        <Seam>
          <SeamCell>
            <Label>Membership</Label>
            <div className="mt-1.5 font-utility text-[14px] font-semibold">{data.membership?.productName ?? 'No active plan'}</div>
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
              <p className="p-3.5 text-[13px] text-foam-65">No visits recorded yet. Your first one shows up here.</p>
            ) : (
              <ul>
                {data.history.map((visit) => (
                  <li key={visit.id} className="flex items-center gap-3 border-b border-line-10 px-3.5 py-2.5 last:border-0">
                    <span aria-hidden="true" className={cx('h-1.5 w-1.5 flex-none', visit.granted ? 'bg-sonar' : 'bg-chum')} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px]">{visit.day}</span>
                      <span className="block truncate text-[11px] text-foam-65">{visit.branchName}</span>
                    </span>
                    <span className="font-utility text-[12px] tabular-nums text-foam-65">{visit.span}</span>
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

function LiveCode({
  code,
  receivedAt,
  acquiring,
  member,
  branchName,
  refetch,
}: {
  code: PassCode & { serverTime?: string };
  receivedAt: number;
  acquiring: boolean;
  member: { name: string; memberNo: string };
  branchName: string;
  refetch: () => void;
}) {
  const now = useNow();
  const reducedMotion = useReducedMotion();
  const serverMs = code.serverTime ? Date.parse(code.serverTime) : code.serverEpoch * 1000;
  const offset = clockOffsetMs(serverMs / 1000, receivedAt);
  const current = codeOnScreen(code, offset, now);
  const requested = useRef<number | null>(null);

  // Top the run up before it runs out, once per run.
  useEffect(() => {
    if ((current === null || current.remaining < REFRESH_WHEN_REMAINING) && requested.current !== receivedAt) {
      requested.current = receivedAt;
      refetch();
    }
  }, [current, receivedAt, refetch]);

  useWakeLock(current !== null);

  if (!current) {
    // The run is spent and a new one has not arrived: acquiring, or failed.
    return acquiring ? (
      <Panel tone="accent" className="relative overflow-hidden p-4" aria-busy="true">
        {reducedMotion ? null : <SonarSweep durationSec={2.8} />}
        <div className="grid aspect-square w-full place-items-center bg-[#ffffff]">
          <span className="font-utility text-[13px] uppercase tracking-[0.14em] text-[#04080b]">Getting a fresh code…</span>
        </div>
      </Panel>
    ) : (
      <MemberNumberFallback memberNo={member.memberNo} name={member.name} reason="refresh" onRetry={refetch} />
    );
  }

  return (
    <Panel tone="accent" className="relative overflow-hidden p-4">
      {acquiring && !reducedMotion ? <SonarSweep durationSec={2.8} /> : null}
      <div className="mx-auto w-full max-w-[320px] bg-[#ffffff] p-3">
        <QrCode value={current.pass.token} label={`Entry code for ${member.name}. Show it to reception to scan.`} />
      </div>
      <div className="mt-3.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-utility text-[17px] font-semibold">
            {member.name} · {member.memberNo}
          </div>
          <div className="mt-0.5 text-[12px] text-foam-65">{branchName}</div>
        </div>
        <div className="text-right" aria-live="off">
          <span className="sr-only">Code changes in </span>
          <span data-testid="pass-countdown" className="font-display text-[24px] tabular-nums leading-none text-sonar">
            {current.secondsLeft}
          </span>
          <span className="ml-1 font-utility text-[11px] uppercase tracking-[0.14em] text-foam-65">sec</span>
        </div>
      </div>
      <Bar value={current.secondsLeft} max={code.rotateSec} className="mt-3" height="h-1" />
      <p className="mt-3 text-[13px] leading-relaxed text-foam-65">
        The code changes every {code.rotateSec} seconds and works once, so a screenshot will not get anyone in. Turn your
        screen brightness up if the scanner struggles.
      </p>
    </Panel>
  );
}

function MemberNumberFallback({
  memberNo,
  name,
  reason,
  onRetry,
}: {
  memberNo: string | null;
  name: string | null;
  reason: 'offline' | 'refresh';
  onRetry?: () => void;
}) {
  return (
    <Panel tone="accent" className="p-4" role="status">
      <Label>{reason === 'offline' ? 'You are offline' : 'Could not get a fresh code'}</Label>
      {memberNo ? (
        <>
          <Display size="sm" as="h2" className="mt-2">
            {memberNo}
          </Display>
          {name ? <p className="mt-1 text-[16px]">{name}</p> : null}
          <p className="mt-3 text-[14px] leading-relaxed">Reception can check you in with this number.</p>
        </>
      ) : (
        <p className="mt-2 text-[14px] leading-relaxed">
          Reception can check you in by your name or phone number.
        </p>
      )}
      <p className="mt-2 text-[13px] text-foam-65">
        {reason === 'offline'
          ? 'Your entry code needs a connection. It comes back as soon as you are online.'
          : 'Your entry code could not be refreshed. Try again in a moment.'}
      </p>
      {onRetry ? (
        <Button variant="outline" size="md" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Panel>
  );
}

function MemberCard({ memberNo, name }: { memberNo: string; name: string }) {
  return (
    <Panel className="p-4">
      <Label>Member number</Label>
      <Display size="sm" as="h2" className="mt-2">
        {memberNo}
      </Display>
      <p className="mt-1 text-[16px]">{name}</p>
    </Panel>
  );
}

function StateNotice({ notice }: { notice: NonNullable<PassPayload['notice']> }) {
  return (
    <Panel tone="warn" className="p-4" role="status">
      <h2 className="font-utility text-[15px] font-semibold uppercase tracking-[0.12em]">{notice.title}</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-foam-80">{notice.body}</p>
      {notice.action === 'billing' ? (
        <Link
          to="/billing"
          className="mt-3 inline-flex min-h-11 items-center border border-line-strong px-4 font-utility text-[12px] font-semibold uppercase tracking-[0.12em] hover:border-sonar hover:text-sonar"
        >
          Open Billing
        </Link>
      ) : notice.action === 'reception' ? (
        <p className="mt-3 text-[13px] text-foam-65">Reception can help with this when you arrive.</p>
      ) : null}
    </Panel>
  );
}

function BranchPicker({
  branches,
  value,
  onChange,
}: {
  branches: PassPayload['branches'];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Branch you are checking in at" className="flex flex-wrap gap-2">
      {branches.map((branch) => {
        const checked = branch.id === value;
        return (
          <button
            key={branch.id}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(branch.id)}
            className={cx(
              'min-h-11 border px-3 font-utility text-[12px] font-semibold uppercase tracking-[0.12em]',
              checked ? 'border-sonar bg-wash-sonar text-sonar' : 'border-line-strong text-foam hover:border-sonar',
            )}
          >
            {branch.name}
            {branch.home ? <span className="sr-only"> (home branch)</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function FullScreen({ onClose, title, children }: { onClose: () => void; title: string; children: ReactNode }) {
  return (
    <div className="sf-inset-x sf-safe-bottom min-h-0 flex-1 overflow-y-auto bg-abyss">
      {/* Clear of the notch and the status bar in an installed app. */}
      <header className="sf-safe-top sticky top-0 z-20 flex min-h-14 items-center border-b border-line bg-hull/95 px-3 backdrop-blur">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close entry pass"
          className="grid h-11 w-11 place-items-center border border-transparent text-sonar hover:border-line"
        >
          <span aria-hidden="true">×</span>
        </button>
        <h1 className="flex-1 text-center font-utility text-[11px] font-semibold uppercase tracking-[0.18em]">{title}</h1>
        <span className="h-11 w-11" aria-hidden="true" />
      </header>
      <div className="sf-column">{children}</div>
    </div>
  );
}

function PassSkeleton({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <FullScreen onClose={onClose} title={title}>
      <div className="flex flex-col gap-4 p-4 pt-5" aria-busy="true">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="aspect-square w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    </FullScreen>
  );
}
