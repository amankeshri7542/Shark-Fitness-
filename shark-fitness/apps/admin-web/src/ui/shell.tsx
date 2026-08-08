import { useEffect, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { navFor } from '@shark/domain';
import { Button, Chip, LiveDot, cx } from './console';
import { useAdmin, useBranchScope, useViewer } from '../lib/store';

/* Each module gets a mark rather than an icon font — a clip-path shape in the
   same vocabulary as the member app's nav, so the two products read as one. */
const MARKS: Record<string, string> = {
  home: 'polygon(50% 0,100% 100%,50% 74%,0 100%)',
  leads: 'polygon(0 0,100% 22%,100% 78%,0 100%,22% 50%)',
  members: 'polygon(0 30%,50% 0,100% 30%,100% 100%,0 100%)',
  memberships: 'polygon(0 0,100% 0,100% 62%,50% 100%,0 62%)',
  billing: 'polygon(0 12%,100% 0,100% 88%,0 100%)',
  attendance: 'polygon(0 62%,26% 20%,52% 62%,78% 8%,100% 40%,100% 100%,0 100%)',
  schedule: 'polygon(0 0,100% 0,100% 100%,0 100%,0 34%,100% 34%)',
  training: 'polygon(0 34%,18% 34%,18% 0,34% 0,34% 100%,18% 100%,18% 66%,0 66%)',
  staff: 'polygon(20% 0,80% 0,100% 100%,0 100%)',
  store: 'polygon(0 26%,20% 0,80% 0,100% 26%,100% 100%,0 100%)',
  equipment: 'polygon(0 40%,40% 40%,40% 0,60% 0,60% 40%,100% 40%,100% 60%,60% 60%,60% 100%,40% 100%,40% 60%,0 60%)',
  automations: 'polygon(0 0,60% 0,60% 40%,100% 40%,100% 100%,40% 100%,40% 60%,0 60%)',
  reports: 'polygon(0 100%,22% 44%,44% 62%,66% 16%,88% 32%,100% 0,100% 100%)',
  support: 'polygon(0 0,100% 0,100% 70%,60% 70%,36% 100%,36% 70%,0 70%)',
  settings: 'polygon(38% 0,62% 0,62% 24%,100% 38%,100% 62%,62% 76%,62% 100%,38% 100%,38% 76%,0 62%,0 38%,38% 24%)',
  platform: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
};

export function Rail() {
  const viewer = useViewer();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const modules = viewer ? navFor(viewer.role) : [];

  return (
    <nav
      aria-label="Modules"
      className="bridge-rail row-span-2 flex flex-col overflow-y-auto border-r border-line bg-hull"
    >
      <div className="flex flex-none items-center gap-2 border-b border-line px-3.5 py-3">
        <span className="font-display text-[18px] uppercase leading-none tracking-[0.06em]">Shark</span>
        <span
          aria-hidden="true"
          className="h-1 w-4"
          style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
        />
        <span className="bridge-rail-label font-utility text-[9px] uppercase tracking-[0.16em] text-foam-35">Ops</span>
      </div>

      <div className="flex flex-1 flex-col">
        {modules.map((module) => {
          const active = module.to === '/' ? pathname === '/' : pathname.startsWith(module.to);
          const colour = active ? 'var(--sf-sonar)' : 'var(--sf-foam-45)';
          return (
            <Link
              key={module.key}
              to={module.to}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'relative flex min-h-11 items-center gap-2.5 border-b border-line-10 px-3.5 py-2.5 transition-colors',
                active ? 'bg-wash-sonar text-sonar' : 'text-foam-65 hover:bg-wash-sonar-soft hover:text-foam',
              )}
            >
              <span
                aria-hidden="true"
                className={cx('absolute inset-y-0 left-0 w-0.5', active ? 'bg-sonar' : 'bg-transparent')}
              />
              <span
                aria-hidden="true"
                className="h-3 w-3 flex-none"
                style={{ background: colour, clipPath: MARKS[module.key] ?? MARKS.home }}
              />
              <span className="bridge-rail-label font-utility text-[11px] font-semibold uppercase tracking-[0.12em]">
                {module.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The status strip. Branch scope, live signals and pending approvals stay
 * visible on every screen, because the PRD requires branch scope to be
 * permanently visible wherever it affects the data.
 */
export function StatusStrip({ alertCount = 0 }: { alertCount?: number }) {
  const viewer = useViewer();
  const { branchName } = useBranchScope();
  const branches = useAdmin((s) => s.branches);
  const activeBranchId = useAdmin((s) => s.activeBranchId);
  const setActiveBranch = useAdmin((s) => s.setActiveBranch);
  const togglePalette = useAdmin((s) => s.togglePalette);
  const theme = useAdmin((s) => s.theme);
  const setTheme = useAdmin((s) => s.setTheme);
  const density = useAdmin((s) => s.density);
  const setDensity = useAdmin((s) => s.setDensity);
  const signOut = useAdmin((s) => s.signOut);
  const navigate = useNavigate();

  return (
    <header className="col-start-2 flex flex-none items-center gap-3 border-b border-line bg-hull px-3.5 py-2">
      <label className="flex items-center gap-2">
        <span className="font-utility text-[9px] uppercase tracking-[0.16em] text-foam-35">Branch</span>
        <select
          aria-label="Active branch"
          className="min-h-8 border border-line bg-panel px-2 py-1 font-utility text-[11px] font-semibold uppercase tracking-[0.1em] text-foam"
          value={activeBranchId ?? ''}
          onChange={(e) => setActiveBranch(e.target.value || null)}
        >
          <option value="">All branches ({branches.length})</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>

      <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-45">{branchName}</span>

      <span className="flex-1" />

      <Button variant="outline" onClick={() => togglePalette(true)} aria-keyshortcuts="Meta+K">
        Search <span className="ml-1 text-foam-35">⌘K</span>
      </Button>

      {alertCount > 0 ? (
        <Link to="/">
          <Chip tone="warn">{alertCount} to act on</Chip>
        </Link>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
          <LiveDot tone="accent" />
          Live
        </span>
      )}

      <button
        type="button"
        onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        className="min-h-8 border border-line-strong px-2 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-foam-50 hover:border-sonar hover:text-sonar"
        aria-label={`Switch to ${density === 'compact' ? 'comfortable' : 'compact'} density`}
      >
        {density === 'compact' ? 'Compact' : 'Comfy'}
      </button>

      <button
        type="button"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        className="min-h-8 border border-line-strong px-2 font-utility text-[10px] font-semibold uppercase tracking-[0.12em] text-foam-50 hover:border-sonar hover:text-sonar"
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? 'Dark' : 'Light'}
      </button>

      {viewer?.userId && viewer.role !== 'owner' ? null : null}

      <div className="flex items-center gap-2 border-l border-line pl-3">
        <span className="grid h-7 w-7 place-items-center border border-line-strong font-utility text-[10px] font-semibold">
          {viewer?.initials ?? '··'}
        </span>
        <div className="hidden leading-tight lg:block">
          <div className="text-[12px]">{viewer?.name}</div>
          <div className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
            {viewer?.role.replace(/_/g, ' ')}
          </div>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            void signOut().then(() => navigate({ to: '/sign-in' }));
          }}
        >
          Sign out
        </Button>
      </div>
    </header>
  );
}

/** Impersonation is never quiet — a support session says so, loudly (PF-PLAT-004). */
export function ImpersonationBanner({ actor, expiresAt }: { actor: string; expiresAt: string }) {
  return (
    <div className="col-span-2 flex items-center gap-3 border-b border-flare bg-wash-flare px-3.5 py-2">
      <span aria-hidden="true" className="text-flare">
        !
      </span>
      <span className="font-utility text-[11px] font-semibold uppercase tracking-[0.14em] text-flare">
        Support access — {actor} is acting as this account
      </span>
      <span className="text-[12px] text-foam-65">
        Every action is audited. Access ends at {new Date(expiresAt).toLocaleTimeString('en-GB')}.
      </span>
    </div>
  );
}

/** The page frame: a title bar, then a seamed console surface beneath. */
export function Page({ title, kicker, actions, children }: {
  title: string;
  kicker?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex flex-none items-end gap-3 border-b border-line px-4 py-3">
        <div>
          {kicker ? (
            <div className="font-utility text-[10px] font-semibold uppercase tracking-[0.18em] text-sonar">{kicker}</div>
          ) : null}
          <h1 className="mt-0.5 font-display text-[24px] uppercase leading-none">{title}</h1>
        </div>
        <span className="flex-1" />
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/** Global search and commands. ⌘K, permission-aware results. */
export function CommandPalette() {
  const open = useAdmin((s) => s.paletteOpen);
  const togglePalette = useAdmin((s) => s.togglePalette);
  const viewer = useViewer();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
      }
      if (e.key === 'Escape') togglePalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette]);

  if (!open || !viewer) return null;

  const modules = navFor(viewer.role).filter((m) =>
    m.label.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[12vh]"
      onClick={() => togglePalette(false)}
      role="presentation"
    >
      <div
        className="w-[min(560px,92vw)] border border-line-strong bg-overlay"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a module, member, invoice or class"
          className="w-full border-0 border-b border-line bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-foam-35"
        />
        <ul className="max-h-[50vh] overflow-y-auto">
          {modules.map((m) => (
            <li key={m.key}>
              <button
                type="button"
                onClick={() => {
                  togglePalette(false);
                  setQuery('');
                  void navigate({ to: m.to });
                }}
                className="flex w-full items-center gap-3 border-b border-line-10 px-4 py-2.5 text-left hover:bg-wash-sonar"
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 flex-none bg-sonar"
                  style={{ clipPath: MARKS[m.key] ?? MARKS.home }}
                />
                <span className="text-[13px]">{m.label}</span>
              </button>
            </li>
          ))}
          {modules.length === 0 ? (
            <li className="px-4 py-4 text-[13px] text-foam-45">
              Nothing matches “{query}”. Try a member name or an invoice number.
            </li>
          ) : null}
        </ul>
        <div className="border-t border-line px-4 py-2 font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
          Results are limited to what your role can see
        </div>
      </div>
    </div>
  );
}
