import { useId, type ReactNode } from 'react';

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

/* — Buttons ————————————————————————————————————————————————

   One hierarchy, applied consistently:

   | variant   | weight    | use                                            |
   |-----------|-----------|------------------------------------------------|
   | `cta`     | dominant  | the ONE action a surface exists to take         |
   | `outline` | standard  | every other real action                         |
   | `ghost`   | quiet     | dismiss, clear, cancel, a link-like affordance  |
   | `danger`  | dominant  | destructive, and only where it is destructive   |

   `cta` is deliberately scarce. It carries the notch, the display face and the
   filled accent, and when a toolbar wears three of them nothing is primary any
   more — which is what a reviewer means by "assembled module by module".

   `pending` exists because 33 call sites were hand-writing
   `{m.isPending ? 'Saving…' : 'Save'}`, each choosing its own participle, and
   each forgetting to disable the button on at least one path. The label is the
   caller's; the busy behaviour is not. — */

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  children: ReactNode;
  variant?: 'cta' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
  full?: boolean;
  disabled?: boolean;
  /**
   * The action is in flight. Disables the control, marks it busy for assistive
   * technology, and shows `pendingLabel` if one is given — so a double press
   * cannot fire a second write while the first is unanswered.
   */
  pending?: boolean;
  pendingLabel?: string;
};

export function Button({
  children,
  variant = 'outline',
  size = 'sm',
  full,
  disabled,
  pending,
  pendingLabel,
  className,
  ...rest
}: ButtonProps) {
  const sizes = {
    sm: 'min-h-9 px-3 text-[11px]',
    md: 'min-h-11 px-4 text-[12px]',
    // Square, so a row of icon actions does not drift out of line with the
    // text buttons beside it.
    icon: 'min-h-9 w-9 px-0 text-[11px]',
  }[size];

  const variants = {
    cta: 'sf-notch border-0 bg-sonar text-on-accent font-display uppercase tracking-[0.12em] text-[13px] hover:brightness-110 active:brightness-95',
    outline:
      'border border-line-strong bg-transparent text-foam font-utility font-semibold uppercase tracking-[0.12em] hover:border-sonar hover:text-sonar active:bg-wash-sonar',
    ghost:
      'border border-transparent bg-transparent text-sonar font-utility font-semibold uppercase tracking-[0.12em] hover:text-foam active:bg-wash-sonar-soft',
    danger:
      'border border-chum bg-transparent text-chum font-utility font-semibold uppercase tracking-[0.12em] hover:bg-wash-chum active:bg-wash-chum',
  }[variant];

  return (
    <button
      type="button"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 transition-[filter,border-color,color,background] duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        // `cta` clips itself to a notch, and a clip-path clips the focus
        // outline with it — so the one button on the surface that most needs
        // to be findable by keyboard was the one losing its ring. An inset
        // shadow is drawn inside the clip and survives.
        variant === 'cta'
          ? 'focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--sf-on-accent)]'
          : '',
        sizes,
        variants,
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

/* — Form controls ——————————————————————————————————————————

   Every field on this console is a label, a control, and at most one line of
   help underneath. That shape was being retyped per screen — 42 hand-written
   `sf-field` strings, most of them carrying `!min-h-9 !text-[13px]` overrides
   to undo the 44px touch default the class sets for the member app's phone
   surfaces — plus 23 raw `<select>` elements each with their own copy of the
   same six Tailwind classes.

   The result was a console where the gap under a label, the height of a
   control and the colour of an error message depended on which week the screen
   was written. These primitives are that shape once. `FieldShell` owns the
   label/hint/error furniture; each control owns only what makes it that
   control. — */

/** Label, control, and one line of hint or error. Never both. */
function FieldShell({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45"
      >
        {label}
      </label>
      {children}
      {/* An error replaces the hint rather than stacking under it — two lines
          of help under one control is how a dense form starts to scroll. */}
      {error ? (
        <p id={`${id}-msg`} className="text-[11px] leading-relaxed text-chum">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-[11px] leading-relaxed text-foam-45">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The one control height on this console. Compact by default; it is a desk. */
const CONTROL = 'sf-field !min-h-9 !py-1.5 !text-[13px]';

const slug = (label: string, id?: string): string =>
  id ?? `f_${label.replace(/\W+/g, '_').toLowerCase()}`;

export function Field({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const inputId = slug(label, id);
  return (
    <FieldShell id={inputId} label={label} hint={hint} error={error} className={className}>
      <input
        id={inputId}
        className={CONTROL}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-msg` : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className,
  id,
  options,
  children,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
  /** Convenience for the common case; pass `children` for grouped options. */
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const inputId = slug(label, id);
  return (
    <FieldShell id={inputId} label={label} hint={hint} error={error} className={className}>
      <select
        id={inputId}
        className={cx(CONTROL, 'cursor-pointer appearance-none pr-7')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-msg` : undefined}
        {...rest}
      >
        {options
          ? options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          : children}
      </select>
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  className,
  id,
  rows = 3,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const inputId = slug(label, id);
  return (
    <FieldShell id={inputId} label={label} hint={hint} error={error} className={className}>
      <textarea
        id={inputId}
        rows={rows}
        className={cx(CONTROL, '!min-h-[72px] resize-y leading-relaxed')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-msg` : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

/**
 * A checkbox with its explanation attached.
 *
 * The label is the hit target and the description sits inside it, because the
 * consequential checkboxes on this console — record this anonymously, waive the
 * fee, override capacity — are exactly the ones whose meaning lives in the
 * small print under them.
 */
export function Checkbox({
  label,
  hint,
  className,
  id,
  ...rest
}: {
  label: ReactNode;
  hint?: ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  // `useId` rather than a random string: a value invented during render is
  // a new id on every re-render, which breaks the label's `htmlFor` link the
  // moment anything above this re-renders.
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <label className={cx('flex cursor-pointer items-start gap-2.5', className)} htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 size-[15px] flex-none cursor-pointer accent-[var(--sf-sonar)]"
        {...rest}
      />
      <span className="min-w-0 text-[13px] leading-relaxed">
        {label}
        {hint ? <span className="mt-0.5 block text-[11px] leading-relaxed text-foam-45">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * The search box that sits in a toolbar rather than in a form.
 *
 * No visible label — a toolbar has no room for one and the placeholder plus
 * `aria-label` carry it — which is exactly why it is a separate primitive
 * instead of `Field` with the label hidden by every caller in its own way.
 */
export function SearchField({
  label,
  className,
  ...rest
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="search"
      aria-label={label}
      className={cx(CONTROL, '!w-auto min-w-[180px] flex-1', className)}
      {...rest}
    />
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

/**
 * Freshness is stated, never implied (PF-DASH-003).
 *
 * The time is the *branch's*, not the browser's. "Live · 14:32" against a
 * machine set to another zone is a figure that reads as fact and is off by
 * hours, which is worse than not stating it at all. Callers pass
 * `useBranchTimeZone()`.
 */
export function Freshness({
  kind,
  asOf,
  timeZone,
}: {
  kind: 'realtime' | 'near_realtime' | 'batch';
  asOf: string;
  timeZone: string;
}) {
  const label = { realtime: 'Live', near_realtime: 'Near real-time', batch: 'Batch' }[kind];
  const tone: Tone = kind === 'realtime' ? 'accent' : kind === 'near_realtime' ? 'neutral' : 'warn';
  return (
    <span className="inline-flex items-center gap-1.5 font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
      <LiveDot tone={tone} />
      {label} · {new Date(asOf).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' })}
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
  return <table className={cx('sf-table', className)}>{children}</table>;
}

/**
 * A sticky header row.
 *
 * The padding, the seam between columns and the sticky behaviour all come from
 * `.sf-table` in `styles.css`, which is also what the density attribute drives.
 * Putting them in Tailwind utilities here is what let the two table systems
 * drift apart in the first place: the CSS one tightened on compact density and
 * the primitives did not.
 */
export function THead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr>{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  align = 'left',
  numeric,
  className,
  sort,
  onSort,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Aligns the heading over the figures it names. */
  numeric?: boolean;
  className?: string;
  sort?: 'asc' | 'desc' | null;
  onSort?: () => void;
}) {
  const alignment = { left: 'text-left', right: 'text-right', center: 'text-center' }[
    numeric ? 'right' : align
  ];
  const label = (
    <span className="inline-flex items-center gap-1">
      {children}
      {/* The arrow is not the only signal — `aria-sort` carries it too — but a
          sighted user scanning twelve columns needs to see which one ordered
          the grid without reading them. */}
      {sort ? <span aria-hidden="true">{sort === 'asc' ? '↑' : '↓'}</span> : null}
    </span>
  );
  return (
    <th
      scope="col"
      aria-sort={sort ? (sort === 'asc' ? 'ascending' : 'descending') : onSort ? 'none' : undefined}
      data-numeric={numeric ? '' : undefined}
      className={cx(alignment, className)}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className={cx(
            'inline-flex cursor-pointer items-center gap-1 uppercase tracking-[0.14em] hover:text-sonar',
            // A sortable heading has to be reachable and hittable, not a 10px
            // word with no target around it.
            'min-h-6 font-utility text-[10px] font-semibold',
          )}
        >
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
    <td data-numeric={numeric ? '' : undefined} className={cx(alignment, className)}>
      {children}
    </td>
  );
}

/**
 * A table row.
 *
 * `onClick` is a **pointer convenience only**, and deliberately carries no
 * role, no `tabIndex` and no key handler. This row used to declare
 * `role="button"`, which does not add a button to a table — it removes a row
 * from one. The row's `row` role, its position, and the column headers that
 * name each cell all disappear from the accessibility tree, so a screen-reader
 * user hears "button, SF-20260818-AB12C Koramangala Walk-in Deepa Kumar Sold
 * ₹1,180.00" instead of a navigable grid, and the table above it reports the
 * wrong number of rows. A real `grid` would need roles on every cell and
 * two-dimensional arrow-key handling; this is a table, so it stays a table.
 *
 * Keyboard operation belongs to a control *inside* the row — see `RowOpen` —
 * which is also what the Design PRD asks for: "Row click and inline controls
 * must not conflict. Interactive cells require explicit hit areas."
 */
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
      // Says which row is open rather than relying on a colour wash alone.
      aria-current={selected ? true : undefined}
      data-selected={selected ? 'true' : undefined}
      className={cx(onClick && 'cursor-pointer', className)}
    >
      {children}
    </tr>
  );
}

/**
 * The control that opens a row, living in the cell that identifies it.
 *
 * Keyboard and screen-reader users reach the receipt number, the reference or
 * the product name and press it; pointer users can still hit anywhere in the
 * row. One name, one action, and the row keeps its semantics.
 */
export function RowOpen({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // The row handles the same click; letting it through would open and
        // then immediately re-open, and on a toggle would cancel itself out.
        e.stopPropagation();
        onClick();
      }}
      className={cx(
        'cursor-pointer text-left underline-offset-4 hover:text-sonar hover:underline focus-visible:underline',
        className,
      )}
    >
      {children}
    </button>
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
  /* Roving tabIndex.

     Every tab used to be a plain button, so all of them were in the tab order:
     reaching the content past a five-tab strip took five presses, and on
     Support with a ticket drawer open that is five presses to get anywhere.
     A tablist is one stop — arrows move within it. Home and End matter more
     here than they look, because these strips are horizontally scrollable and
     the last tab is often off screen. */
  const move = (index: number): void => {
    const target = items[(index + items.length) % items.length];
    if (!target) return;
    onChange(target.key);
    document.getElementById(`tab-${target.key}`)?.focus();
  };

  const at = items.findIndex((i) => i.key === active);

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
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(at + 1); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); move(at - 1); }
              else if (e.key === 'Home') { e.preventDefault(); move(0); }
              else if (e.key === 'End') { e.preventDefault(); move(items.length - 1); }
            }}
            className={cx(
              'relative min-h-10 shrink-0 cursor-pointer whitespace-nowrap border-r border-line px-4 font-utility text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors',
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

/**
 * A small exclusive choice: a tender method, a state filter, a period.
 *
 * Same keyboard contract as `Tabs` — one stop in the tab order, arrows and
 * Home/End inside — because to anyone driving this console by keyboard the two
 * are the same control wearing different clothes, and having one of them eat
 * six tab stops while the other ate one was simply a thing nobody had tried.
 */
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
  // Matches the control height so a segmented sitting beside a select or a
  // button in a toolbar lines up with it rather than floating a pixel high.
  const height = size === 'md' ? 'min-h-9 text-[11px]' : 'min-h-8 text-[10px]';
  const at = options.findIndex((o) => o.value === value);

  const move = (index: number): void => {
    const target = options[(index + options.length) % options.length];
    if (!target) return;
    onChange(target.value);
    document.getElementById(`seg-${label}-${target.value}`)?.focus();
  };

  return (
    <div role="group" aria-label={label} className="flex min-w-0 border border-line-strong">
      {options.map((option, index) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            id={`seg-${label}-${option.value}`}
            aria-pressed={isActive}
            // Roving: the group is one tab stop and arrows move inside it.
            // `radiogroup` would be the tidier semantic for an exclusive
            // choice, but these are filters that sit in toolbars beside real
            // buttons, and re-announcing them as radios is a bigger change to
            // how the console reads than this pass is for.
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(at + 1); }
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(at - 1); }
              else if (e.key === 'Home') { e.preventDefault(); move(0); }
              else if (e.key === 'End') { e.preventDefault(); move(options.length - 1); }
            }}
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
