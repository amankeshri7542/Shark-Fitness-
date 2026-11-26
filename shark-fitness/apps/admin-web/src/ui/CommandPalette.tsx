import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { can as canRole, modulesFor, type Permission } from '@shark/domain';
import { ApiError, OfflineError, api } from '../lib/api';
import { useAdmin, useViewer } from '../lib/store';
import { cx } from './console';
import { useFocusTrap } from './overlay';
import { NewTaskDialog } from './NewTaskDialog';
import { QuickAddDialog } from './QuickAddDialog';

/**
 * ⌘K / Ctrl+K — search the gym and act (P07; PRD 01 §4.2, Design PRD
 * "Global search").
 *
 * One input, one list. Typing two characters searches members, leads,
 * invoices, classes and staff on the server (permission- and branch-aware,
 * debounced); actions and modules match locally. Two actions ask a follow-up
 * question in the same box: "Record payment" looks for the invoice, "Check in
 * member" looks for the member. Recent picks come back first when the box is
 * empty.
 *
 * ARIA: a combobox input that owns a listbox; arrows move the active option
 * (aria-activedescendant), Enter opens it, Escape steps back out of a
 * follow-up question and then closes. Focus stays in the input throughout.
 */

type Mode = 'all' | 'payment' | 'checkin';

interface SearchResult {
  type: 'member' | 'lead' | 'invoice' | 'class' | 'staff';
  id: string;
  title: string;
  subtitle: string;
  to: string;
  meta?: Record<string, string>;
}

interface Item {
  key: string;
  group: string;
  label: string;
  detail?: string;
  run: () => void;
  /** Saved to recents when picked. */
  recent?: RecentItem;
}

interface RecentItem {
  key: string;
  label: string;
  detail?: string;
  to: string;
}

const RECENT_KEY = 'shark.admin.palette.recent';
const TYPE_LABEL: Record<SearchResult['type'], string> = {
  member: 'Members',
  lead: 'Leads',
  invoice: 'Invoices',
  class: 'Classes',
  staff: 'Staff',
};

function readRecents(): RecentItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as RecentItem[]).filter((r) => typeof r?.to === 'string' && r.to.startsWith('/')).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecent(item: RecentItem): void {
  try {
    const next = [item, ...readRecents().filter((r) => r.key !== item.key)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode: recents are a convenience */
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Splits "/billing?invoice=x&pay=1" for the router. */
function splitPath(to: string): { to: string; search: Record<string, string | number> } {
  const [path = '/', query = ''] = to.split('?');
  const search: Record<string, string | number> = {};
  for (const [k, v] of new URLSearchParams(query)) search[k] = /^\d+$/.test(v) && k !== 'q' ? Number(v) : v;
  return { to: path, search };
}

export function CommandPalette() {
  const open = useAdmin((s) => s.paletteOpen);
  const togglePalette = useAdmin((s) => s.togglePalette);
  const activeBranchId = useAdmin((s) => s.activeBranchId);
  const viewer = useViewer();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('all');
  const [active, setActive] = useState(0);
  const [dialog, setDialog] = useState<'quick-add' | 'task' | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const close = (): void => {
    togglePalette(false);
    setQuery('');
    setMode('all');
    setActive(0);
  };
  // Escape steps back out of a follow-up question first, then closes. The
  // focus trap owns Escape (capture phase), so the decision is made here.
  const panelRef = useFocusTrap(
    open,
    () => {
      if (mode !== 'all') {
        setMode('all');
        setQuery('');
        setActive(0);
        inputRef.current?.focus();
      } else close();
    },
    inputRef,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePalette]);

  const role = viewer?.role;
  const canByRole = (permission: Permission): boolean => Boolean(role && canRole(role, permission));

  const term = query.trim();
  const debounced = useDebounced(term, 200);
  const types = mode === 'payment' ? 'invoice' : mode === 'checkin' ? 'member' : '';
  const search = useQuery({
    queryKey: ['palette', debounced, mode, activeBranchId],
    queryFn: () =>
      api<{ results: SearchResult[] }>(
        `/admin/search?q=${encodeURIComponent(debounced)}${types ? `&types=${types}` : ''}${mode === 'payment' ? '&outstanding=1' : ''}`,
      ),
    enabled: open && debounced.length >= 2,
    staleTime: 10_000,
  });

  const go = (to: string): void => {
    const target = splitPath(to);
    close();
    void navigate({ to: target.to, search: target.search as never });
  };

  const items: Item[] = useMemo(() => {
    if (!role) return [];
    const out: Item[] = [];
    const lower = term.toLowerCase();
    const results = debounced.length >= 2 && debounced === term ? (search.data?.results ?? []) : [];

    if (mode === 'payment') {
      for (const r of results.filter((x) => x.type === 'invoice')) {
        out.push({
          key: `pay:${r.id}`,
          group: 'Choose the invoice',
          label: r.title,
          detail: r.subtitle,
          run: () => go(`/billing?invoice=${r.id}&pay=1`),
        });
      }
      return out;
    }
    if (mode === 'checkin') {
      for (const r of results.filter((x) => x.type === 'member')) {
        out.push({
          key: `checkin:${r.id}`,
          group: 'Choose the member',
          label: r.title,
          detail: r.subtitle,
          run: () => go(`/floor?q=${encodeURIComponent(r.meta?.memberNo ?? r.title)}`),
        });
      }
      return out;
    }

    if (!term) {
      for (const r of readRecents()) {
        out.push({ key: `recent:${r.key}`, group: 'Recent', label: r.label, detail: r.detail, run: () => go(r.to), recent: r });
      }
    }
    const actions: Array<{ key: string; label: string; detail: string; permission: Permission; run: () => void }> = [
      { key: 'add-member', label: 'Add member', detail: 'A walk-in: name, phone, branch', permission: 'member.edit', run: () => { close(); setDialog('quick-add'); } },
      { key: 'record-payment', label: 'Record payment', detail: 'Find the invoice, then take the payment', permission: 'billing.record_payment', run: () => { setMode('payment'); setQuery(''); setActive(0); } },
      { key: 'check-in', label: 'Check in member', detail: 'Find the member at the desk', permission: 'attendance.checkin', run: () => { setMode('checkin'); setQuery(''); setActive(0); } },
      { key: 'create-class', label: 'Create class', detail: 'A new recurring class', permission: 'schedule.manage', run: () => go('/schedule?tab=series&create=1') },
      { key: 'new-task', label: 'New task', detail: 'Something for you or a colleague to do', permission: 'task.view', run: () => { close(); setDialog('task'); } },
    ];
    for (const a of actions) {
      if (!canByRole(a.permission)) continue;
      if (lower && !a.label.toLowerCase().includes(lower)) continue;
      out.push({ key: `action:${a.key}`, group: 'Actions', label: a.label, detail: a.detail, run: a.run });
    }
    // A typed command outranks a search hit: "record" means Record payment.
    for (const r of results) {
      const recent = { key: `${r.type}:${r.id}`, label: r.title, detail: r.subtitle, to: r.to };
      out.push({ key: recent.key, group: TYPE_LABEL[r.type], label: r.title, detail: r.subtitle, run: () => go(r.to), recent });
    }

    for (const m of modulesFor(role)) {
      if (lower && !m.label.toLowerCase().includes(lower)) continue;
      out.push({
        key: `module:${m.key}`,
        group: 'Go to',
        label: m.label,
        run: () => go(m.to),
        recent: { key: `module:${m.key}`, label: m.label, detail: 'Module', to: m.to },
      });
    }
    return out;
    // `go`, `close` and the action closures read current state through setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, term, debounced, mode, search.data]);

  useEffect(() => {
    setActive((i) => (items.length === 0 ? 0 : Math.min(i, items.length - 1)));
  }, [items.length]);

  const pick = (item: Item | undefined): void => {
    if (!item) return;
    if (item.recent) saveRecent(item.recent);
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, items.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[active]);
    }
  };

  const optionId = (index: number) => `${listId}-opt-${index}`;
  const placeholder =
    mode === 'payment' ? 'Invoice number or member name' : mode === 'checkin' ? 'Member name or number' : 'Search members, invoices, classes… or type an action';
  const status =
    term.length === 1 && mode !== 'all'
      ? 'Keep typing…'
      : search.isFetching && debounced.length >= 2
        ? 'Searching…'
        : search.error instanceof OfflineError
          ? 'Offline: only actions and modules are available.'
          : search.error instanceof ApiError
            ? search.error.message
            : term.length >= 2 && items.length === 0
              ? `Nothing matches “${term}”.`
              : null;

  let lastGroup = '';

  return (
    <>
      {open && viewer ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[12vh]" onClick={close} role="presentation">
          <div
            ref={panelRef}
            tabIndex={-1}
            data-overlay-panel=""
            className="w-[min(600px,92vw)] border border-line-strong bg-overlay"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Search and commands"
          >
            {mode !== 'all' ? (
              <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12px] text-foam-80">
                <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-sonar">
                  {mode === 'payment' ? 'Record payment' : 'Check in member'}
                </span>
                <span>Esc to go back</span>
              </div>
            ) : null}
            <input
              ref={inputRef}
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={items.length ? optionId(active) : undefined}
              aria-label={mode === 'payment' ? 'Find the invoice' : mode === 'checkin' ? 'Find the member' : 'Search and commands'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="w-full border-0 border-b border-line bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-foam-45"
            />
            <ul id={listId} role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto">
              {items.map((item, index) => {
                const header = item.group !== lastGroup ? item.group : null;
                lastGroup = item.group;
                return (
                  <li
                    key={item.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(item)}
                    className={cx('cursor-pointer border-b border-line-10 px-4 py-2', index === active ? 'bg-wash-sonar' : '')}
                  >
                    {header ? (
                      <span className="mb-0.5 block font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-80" aria-hidden="true">
                        {header}
                      </span>
                    ) : null}
                    <span className="block text-[13px] text-foam">{item.label}</span>
                    {item.detail ? <span className="block text-[12px] text-foam-80">{item.detail}</span> : null}
                  </li>
                );
              })}
            </ul>
            <div role="status" aria-live="polite" className="px-4 py-2 text-[12px] text-foam-80">
              {status ?? (mode === 'all' && term.length < 2 ? 'Type two letters to search. ↑↓ to move, Enter to open.' : '')}
            </div>
          </div>
        </div>
      ) : null}
      {dialog === 'quick-add' ? <QuickAddDialog open onClose={() => setDialog(null)} /> : null}
      {dialog === 'task' ? <NewTaskDialog open onClose={() => setDialog(null)} /> : null}
    </>
  );
}
