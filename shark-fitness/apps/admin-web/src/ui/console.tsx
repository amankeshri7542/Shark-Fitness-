import type { ReactNode } from 'react';

/* ============================================================================
   Bridge primitives — the dense, desktop half of the Sonar system.

   Same tokens, same geometry, different density. Where the member app breathes,
   this packs; the PRD asks for "dense but breathable" and the seam does the
   breathing so the padding does not have to.
   ========================================================================= */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Eyebrow({ children, tone = 'accent', className }: {
  children: ReactNode;
  tone?: 'accent' | 'muted';
  className?: string;
}) {
  return (
    <span
      className={cx(
        'font-utility text-[10px] font-semibold uppercase tracking-[0.18em]',
        tone === 'accent' ? 'text-sonar' : 'text-foam-45',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45', className)}>
      {children}
    </span>
  );
}

export function Display({ children, size = 'md', className, as: Tag = 'h1' }: {
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
}) {
  const scale = { sm: 'text-[16px]', md: 'text-[22px]', lg: 'text-[30px]' }[size];
  return <Tag className={cx('font-display uppercase leading-[0.96]', scale, className)}>{children}</Tag>;
}

export function Metric({ value, unit, size = 'md', tone = 'default', className }: {
  value: ReactNode;
  unit?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'accent' | 'warn' | 'bad' | 'good';
  className?: string;
}) {
  const scale = { sm: 'text-[16px]', md: 'text-[26px]', lg: 'text-[34px]' }[size];
  const colour = { default: '', accent: 'text-sonar', warn: 'text-flare', bad: 'text-chum', good: 'text-kelp' }[tone];
  return (
    <span className={cx('font-display leading-none tabular-nums', scale, colour, className)}>
      {value}
      {unit ? <span className="text-[0.45em] text-foam-50"> {unit}</span> : null}
    </span>
  );
}

/**
 * A panel in the console grid. Deliberately has NO outer margin — it butts
 * against its neighbours and the seam does the separating.
 */
export function Panel({ title, action, children, className, tone = 'plain', span }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: 'plain' | 'accent' | 'warn' | 'bad' | 'good';
  span?: string;
}) {
  const tones = {
    plain: '',
    accent: 'bg-wash-sonar',
    warn: 'bg-wash-flare',
    bad: 'bg-wash-chum',
    good: 'bg-wash-kelp',
  }[tone];
  return (
    <section className={cx('flex min-w-0 flex-col', tones, span, className)}>
      {title ? (
        <header className="flex flex-none items-center gap-2 border-b border-line px-3.5 py-2.5">
          <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.18em] text-foam-45">
            {title}
          </span>
          <span className="flex-1" />
          {action}
        </header>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

/** A row of cells sharing edges. The system's structural unit. */
export function Seam({ children, className, direction = 'x' }: {
  children: ReactNode;
  className?: string;
  direction?: 'x' | 'y';
}) {
  return <div className={cx('flex', direction === 'x' ? 'flex-row seam-x' : 'flex-col seam-y', className)}>{children}</div>;
}

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

const TONE_STYLE: Record<Tone, { className: string; glyph: string }> = {
  neutral: { className: 'text-foam-50', glyph: '·' },
  accent: { className: 'text-sonar', glyph: '◆' },
  good: { className: 'text-kelp', glyph: '✓' },
  warn: { className: 'text-flare', glyph: '!' },
  bad: { className: 'text-chum', glyph: '×' },
};

/** Status always pairs colour with a glyph — never hue alone. */
export function Chip({ children, tone = 'neutral', glyph = true, className }: {
  children: ReactNode;
  tone?: Tone;
  glyph?: boolean;
  className?: string;
}) {
  const style = TONE_STYLE[tone];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 border border-current px-1.5 py-[2px]',
        'font-utility text-[9px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap',
        style.className,
        className,
      )}
    >
      {glyph ? <span aria-hidden="true">{style.glyph}</span> : null}
      {children}
    </span>
  );
}

export function LiveDot({ tone = 'accent' }: { tone?: Tone }) {
  const bg = { accent: 'bg-sonar', good: 'bg-kelp', warn: 'bg-flare', bad: 'bg-chum', neutral: 'bg-foam-45' }[tone];
  return <span aria-hidden="true" className={cx('inline-block h-1.5 w-1.5 animate-breath', bg)} />;
}

export function Bar({ value, max = 100, tone = 'accent', height = 'h-1.5', className }: {
  value: number;
  max?: number;
  tone?: Tone;
  height?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill = { accent: 'bg-sonar', good: 'bg-kelp', warn: 'bg-flare', bad: 'bg-chum', neutral: 'bg-foam-45' }[tone];
  return (
    <div className={cx('w-full bg-[var(--sf-data-track)]', height, className)}>
      <div className={cx('h-full transition-[width] duration-500', fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* — Controls ——————————————————————————————————————————————— */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'cta' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  full?: boolean;
};

export function Button({ children, variant = 'outline', size = 'sm', full, className, ...rest }: ButtonProps) {
  const sizes = { sm: 'min-h-9 px-3 text-[11px]', md: 'min-h-11 px-4 text-[12px]' }[size];
  const variants = {
    cta: 'sf-notch border-0 bg-sonar text-on-accent font-display uppercase tracking-[0.12em] text-[13px] hover:brightness-110',
    outline:
      'border border-line-strong bg-transparent text-foam font-utility font-semibold uppercase tracking-[0.12em] hover:border-sonar hover:text-sonar',
    ghost: 'border border-transparent bg-transparent text-sonar font-utility font-semibold uppercase tracking-[0.12em] hover:text-foam',
    danger:
      'border border-chum bg-transparent text-chum font-utility font-semibold uppercase tracking-[0.12em] hover:bg-wash-chum',
  }[variant];
  return (
    <button
      type="button"
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 transition-[filter,border-color,color,background] duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        sizes,
        variants,
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, error, className, id, ...rest }: {
  label: string;
  hint?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const inputId = id ?? `f_${label.replace(/\W+/g, '_').toLowerCase()}`;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
        {label}
      </label>
      <input id={inputId} className="sf-field !min-h-9 !py-2 !text-[13px]" aria-invalid={error ? true : undefined} {...rest} />
      {error ? <p className="text-[11px] text-chum">{error}</p> : hint ? <p className="text-[11px] text-foam-45">{hint}</p> : null}
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-2 border-b border-line bg-hull px-3.5 py-2.5', className)}>
      {children}
    </div>
  );
}

/** Bulk actions only appear once something is selected (Design PRD §5.5). */
export function BulkBar({ count, children, onClear }: { count: number; children: ReactNode; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2 border-b border-line-accent bg-wash-sonar px-3.5 py-2">
      <span className="font-utility text-[11px] font-semibold uppercase tracking-[0.14em] text-sonar">
        {count} selected
      </span>
      <span className="flex-1" />
      {children}
      <Button variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

/* — States ————————————————————————————————————————————————— */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('sf-skeleton', className)} aria-hidden="true" />;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2.5 p-6">
      <Display size="sm" as="h3">
        {title}
      </Display>
      <p className="max-w-[46ch] text-[13px] leading-relaxed text-foam-65">{body}</p>
      {action}
    </div>
  );
}

export function ErrorState({ title, body, onRetry, requestId }: {
  title: string;
  body: string;
  onRetry?: () => void;
  requestId?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2.5 bg-wash-chum p-6">
      <div className="flex items-center gap-2 text-chum">
        <span aria-hidden="true">×</span>
        <Display size="sm" as="h3">
          {title}
        </Display>
      </div>
      <p className="max-w-[46ch] text-[13px] leading-relaxed text-foam-65">{body}</p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {requestId ? <p className="font-utility text-[10px] tracking-[0.1em] text-foam-35">Ref {requestId}</p> : null}
    </div>
  );
}

/** Permission denial is a state of its own — never an empty table. */
export function PermissionState({ what }: { what: string }) {
  return (
    <div className="flex flex-col items-start gap-2 p-6">
      <Label>Not available to your role</Label>
      <p className="max-w-[46ch] text-[13px] leading-relaxed text-foam-65">
        {what} is restricted. An owner or regional manager can change what your role can reach in Settings.
      </p>
    </div>
  );
}

/** Freshness is stated, never implied (PF-DASH-003). */
export function Freshness({ kind, asOf }: { kind: 'realtime' | 'near_realtime' | 'batch'; asOf: string }) {
  const label = { realtime: 'Live', near_realtime: 'Near real-time', batch: 'Batch' }[kind];
  const tone: Tone = kind === 'realtime' ? 'accent' : kind === 'near_realtime' ? 'neutral' : 'warn';
  return (
    <span className="inline-flex items-center gap-1.5 font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
      <LiveDot tone={tone} />
      {label} · {new Date(asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

/* ============================================================================
   Dense data — added for the Store workspace, shaped to be reused.

   A shop's inventory is the first screen in this console with more rows than
   fit and more columns than a phone can hold, so the table primitives below
   solve that once: the header stays put while the body scrolls, and the
   *table* scrolls sideways inside its own box rather than pushing the page
   into a horizontal scrollbar.
   ========================================================================= */

/** The horizontal-scroll boundary. Wide content stops here, never at the page. */
export function TableScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('min-w-0 overflow-x-auto overflow-y-auto', className)}>{children}</div>;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cx('w-full min-w-max border-collapse text-[13px]', className)}>{children}</table>;
}

/**
 * A sticky header row. `bg-hull` is opaque on purpose — a translucent header
 * over scrolling numbers is unreadable, and this table is nothing but numbers.
 */
export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-hull">
      <tr className="border-b border-line">{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  align = 'left',
  className,
  sort,
  onSort,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  sort?: 'asc' | 'desc' | null;
  onSort?: () => void;
}) {
  const alignment = { left: 'text-left', right: 'text-right', center: 'text-center' }[align];
  const label = (
    <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
      {children}
      {sort ? <span aria-hidden="true"> {sort === 'asc' ? '↑' : '↓'}</span> : null}
    </span>
  );
  return (
    <th
      scope="col"
      aria-sort={sort ? (sort === 'asc' ? 'ascending' : 'descending') : onSort ? 'none' : undefined}
      className={cx('whitespace-nowrap px-3 py-2', alignment, className)}
    >
      {onSort ? (
        <button type="button" onClick={onSort} className="cursor-pointer hover:text-sonar">
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  );
}

export function TD({
  children,
  align = 'left',
  numeric,
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Right-aligns and locks digit width so a column does not dance as it ticks. */
  numeric?: boolean;
  className?: string;
}) {
  const alignment = { left: 'text-left', right: 'text-right', center: 'text-center' }[
    numeric ? 'right' : align
  ];
  return (
    <td className={cx('px-3 py-2 align-middle', alignment, numeric && 'tabular-nums', className)}>{children}</td>
  );
}

export function TR({
  children,
  onClick,
  selected,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      // A clickable row is reachable and operable from the keyboard, and says
      // which one is open rather than relying on a colour wash alone.
      {...(onClick ? { tabIndex: 0, role: 'button' as const } : {})}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      aria-current={selected ? true : undefined}
      className={cx(
        'border-b border-line-10',
        onClick && 'cursor-pointer hover:bg-wash-sonar-soft focus-visible:bg-wash-sonar-soft',
        selected && 'bg-wash-sonar',
        className,
      )}
    >
      {children}
    </tr>
  );
}

/* — Workspace navigation ———————————————————————————————————————— */

export interface TabItem {
  key: string;
  label: string;
  /** Shown after the label. A count, not a badge for its own sake. */
  hint?: string;
}

/**
 * The section switcher for a module with several working surfaces.
 *
 * Not numbered: these are five places to stand, not five steps to take, and
 * numbering them would claim an order the work does not have. The active mark
 * is the rail's left bar rotated flat, so a module's inside reads like its
 * outside.
 */
export function Tabs({
  items,
  active,
  onChange,
  label,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex min-w-0 overflow-x-auto border-b border-line bg-hull">
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`tab-${item.key}`}
            aria-selected={isActive}
            aria-controls={`panel-${item.key}`}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const at = items.findIndex((i) => i.key === active);
              const next = e.key === 'ArrowRight' ? at + 1 : at - 1;
              const target = items[(next + items.length) % items.length];
              if (target) {
                onChange(target.key);
                document.getElementById(`tab-${target.key}`)?.focus();
              }
            }}
            className={cx(
              'relative min-h-10 whitespace-nowrap border-r border-line px-4 font-utility text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors',
              isActive ? 'bg-wash-sonar text-sonar' : 'text-foam-50 hover:bg-wash-sonar-soft hover:text-foam',
            )}
          >
            <span aria-hidden="true" className={cx('absolute inset-x-0 bottom-0 h-0.5', isActive ? 'bg-sonar' : 'bg-transparent')} />
            {item.label}
            {item.hint ? <span className="ml-1.5 tabular-nums text-foam-35">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A small exclusive choice: a tender method, a state filter. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'sm',
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const height = size === 'md' ? 'min-h-10 text-[12px]' : 'min-h-8 text-[10px]';
  return (
    <div role="group" aria-label={label} className="flex min-w-0 border border-line-strong">
      {options.map((option, index) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(option.value)}
            className={cx(
              'flex-1 cursor-pointer whitespace-nowrap px-2.5 font-utility font-semibold uppercase tracking-[0.12em] transition-colors',
              height,
              index > 0 && 'border-l border-line',
              isActive ? 'bg-sonar text-on-accent' : 'text-foam-50 hover:text-sonar',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A quantity control. The label names the thing being counted, because "plus"
 * announced twelve times down a catalogue tells a screen-reader user nothing.
 */
export function Stepper({
  value,
  onChange,
  min = 0,
  max,
  label,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** The item being counted, e.g. "Shark Tee — M". */
  label: string;
  disabled?: boolean;
}) {
  const atMin = disabled || value <= min;
  const atMax = disabled || (max !== undefined && value >= max);
  return (
    <div className="flex items-center gap-1">
      <Button
        aria-label={`Remove one ${label}`}
        disabled={atMin}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="!px-2.5"
      >
        <span aria-hidden="true">−</span>
      </Button>
      <input
        type="number"
        aria-label={`Quantity of ${label}`}
        value={value}
        min={min}
        {...(max !== undefined ? { max } : {})}
        disabled={disabled}
        onChange={(e) => {
          const next = Number.parseInt(e.target.value, 10);
          if (Number.isNaN(next)) return;
          onChange(Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, next)));
        }}
        className="sf-field !min-h-9 !w-14 !px-1 !py-1 !text-center !text-[13px] tabular-nums"
      />
      <Button
        aria-label={`Add one ${label}`}
        disabled={atMax}
        onClick={() => onChange(value + 1)}
        className="!px-2.5"
      >
        <span aria-hidden="true">+</span>
      </Button>
    </div>
  );
}

/**
 * A money value the viewer's role may not see.
 *
 * Never a blank cell and never a zero: PF-RPT-005 asks for a permission state,
 * and in a shop `₹0.00` is a real figure that would read as fact.
 */
export function Restricted({ label = 'Restricted' }: { label?: string }) {
  return (
    <span
      title="Your role does not include financial figures"
      className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35"
    >
      {label}
    </span>
  );
}
