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
