import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { LiveDot, Scanlines, cx } from './primitives';
import { useCopy, useViewer } from '../lib/store';
import { useConnection } from '../lib/realtime';
import { useOutboxCount } from '../lib/outbox';

/* The five nav marks from the prototype, kept as clip-paths so they stay
   crisp at any density and tint with a single colour. */
const NAV = [
  { to: '/', key: 'navHome' as const, clip: 'polygon(50% 0,100% 100%,50% 74%,0 100%)' },
  {
    to: '/pass',
    key: null,
    label: 'Pass',
    clip:
      'polygon(0 0,12% 0,12% 100%,0 100%,0 0,24% 0,36% 0,36% 100%,24% 100%,24% 0,48% 0,60% 0,60% 100%,48% 100%,48% 0,72% 0,88% 0,88% 100%,72% 100%,72% 0,100% 0,100% 100%,94% 100%,94% 0)',
  },
  { to: '/train', key: 'navTrain' as const, clip: 'polygon(0 0,52% 0,100% 50%,52% 100%,0 100%,48% 50%)' },
  { to: '/progress', key: 'navProgress' as const, clip: 'polygon(0 100%,100% 100%,100% 0,66% 0,66% 38%,33% 38%,33% 70%,0 70%)' },
  { to: '/pack', key: 'navPack' as const, dots: true },
] as const;

export function BottomNav() {
  const copy = useCopy();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      aria-label="Main"
      className="sf-safe-bottom relative flex flex-none border-t border-line bg-hull"
    >
      {NAV.map((item) => {
        const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
        const colour = active ? 'var(--sf-sonar)' : 'var(--sf-foam-45)';
        const label = 'key' in item && item.key ? copy(item.key) : (item as { label: string }).label;

        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className="relative flex min-h-[58px] flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 px-1 pb-3 pt-3"
          >
            <span
              aria-hidden="true"
              className={cx('absolute inset-x-0 top-0 h-0.5', active ? 'bg-sonar' : 'bg-transparent')}
            />
            <span
              aria-hidden="true"
              className="h-[15px] w-[17px] transition-[background] duration-150"
              style={
                'dots' in item && item.dots
                  ? {
                      background: [
                        `radial-gradient(circle 3px at 3.5px 9px, ${colour} 98%, transparent 100%)`,
                        `radial-gradient(circle 4px at 8.5px 5px, ${colour} 98%, transparent 100%)`,
                        `radial-gradient(circle 3px at 13.5px 9px, ${colour} 98%, transparent 100%)`,
                      ].join(','),
                      backgroundRepeat: 'no-repeat',
                    }
                  : { background: colour, clipPath: (item as { clip: string }).clip }
              }
            />
            <span
              className="font-utility text-[10px] font-semibold uppercase tracking-[0.1em]"
              style={{ color: colour }}
            >
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppHeader({ branchName }: { branchName: string }) {
  const viewer = useViewer();
  const connection = useConnection();
  const queued = useOutboxCount();

  const status =
    queued > 0
      ? { tone: 'warn' as const, label: `${queued} queued` }
      : connection === 'open'
        ? { tone: 'accent' as const, label: 'Live' }
        : connection === 'connecting'
          ? { tone: 'neutral' as const, label: 'Syncing' }
          : { tone: 'warn' as const, label: 'Offline' };

  return (
    <header className="sf-safe-top relative flex flex-none items-center gap-2.5 border-b border-line px-4 pb-2.5 pt-3">
      <span className="font-display text-[22px] uppercase leading-none tracking-[0.06em]">Shark</span>
      <span
        aria-hidden="true"
        className="h-1.5 w-[22px]"
        style={{
          background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)',
        }}
      />
      <span className="flex-1 truncate font-utility text-[11px] font-semibold uppercase tracking-[0.14em] text-foam-45">
        {branchName}
      </span>
      <span className="flex items-center gap-1.5 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-foam-50">
        <LiveDot tone={status.tone} />
        {status.label}
      </span>
      <Link
        to="/profile"
        aria-label="Your profile and settings"
        className="grid h-8 w-8 place-items-center border border-line-strong font-utility text-[12px] font-semibold tracking-[0.04em] hover:border-sonar hover:text-sonar"
      >
        {viewer?.initials ?? '··'}
      </Link>
    </header>
  );
}

/** The scrolling body of a screen, with the prototype's top vignette. */
export function ScreenBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={cx('relative flex-1 overflow-y-auto overflow-x-hidden', className)}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background: 'radial-gradient(120% 60% at 50% -10%, var(--sf-shelf-top) 0%, transparent 62%)',
        }}
      />
      <div className="relative">{children}</div>
    </main>
  );
}

/** The full-bleed hero used on Home and the top of the section screens. */
export function Hero({ kicker, children, stats }: {
  kicker: ReactNode;
  children: ReactNode;
  stats?: ReactNode;
}) {
  return (
    <div
      className="relative overflow-hidden border-b border-line px-4 pb-5 pt-6"
      style={{
        background: 'linear-gradient(180deg, var(--sf-shelf-top) 0%, var(--sf-shelf-mid) 55%, var(--sf-abyss) 100%)',
      }}
    >
      <Scanlines />
      <div className="relative">
        <div className="font-utility text-[11px] font-semibold uppercase tracking-[0.2em] text-sonar">{kicker}</div>
        {children}
        {stats}
      </div>
    </div>
  );
}

/** Standard padded stack. Matches the prototype's 16px / 14px rhythm. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex flex-col gap-3.5 p-4 pb-6', className)}>{children}</div>;
}

/** Screen enter animation, reduced-motion aware via the token layer. */
export function Surface({ children }: { children: ReactNode }) {
  return <div className="animate-surface">{children}</div>;
}
