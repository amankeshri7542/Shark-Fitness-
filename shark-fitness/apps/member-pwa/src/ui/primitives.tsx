import type { ReactNode } from 'react';

/* ============================================================================
   Sonar primitives.

   Every member screen is built from these. They exist so the design language
   lives in one place: hairline seams, zero radius, Anton for anything numeric,
   Archivo Narrow for the uppercase micro-labels. See docs/DESIGN.md.
   ========================================================================= */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* — Type roles ————————————————————————————————————————————— */

export function Eyebrow({ children, tone = 'accent', className }: {
  children: ReactNode;
  tone?: 'accent' | 'muted';
  className?: string;
}) {
  return (
    <span
      className={cx(
        'font-utility text-[11px] font-semibold uppercase tracking-[0.2em]',
        tone === 'accent' ? 'text-sonar' : 'text-foam-50',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Display heading. Anton, uppercase, tight. */
export function Display({ children, size = 'lg', className, as: Tag = 'h1' }: {
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
}) {
  const scale = {
    sm: 'text-[22px]',
    md: 'text-[30px]',
    lg: 'text-[38px]',
    xl: 'text-[44px]',
  }[size];
  return <Tag className={cx('font-display uppercase leading-[0.95]', scale, className)}>{children}</Tag>;
}

/** A number that matters. Always tabular so it does not jitter as it ticks. */
export function Metric({ value, unit, size = 'md', tone = 'default', className }: {
  value: ReactNode;
  unit?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'default' | 'accent' | 'warn' | 'bad' | 'good';
  className?: string;
}) {
  const scale = { sm: 'text-[18px]', md: 'text-[26px]', lg: 'text-[34px]', xl: 'text-[52px]' }[size];
  const colour = {
    default: '',
    accent: 'text-sonar',
    warn: 'text-flare',
    bad: 'text-chum',
    good: 'text-kelp',
  }[tone];
  return (
    <span className={cx('font-display leading-none tabular-nums', scale, colour, className)}>
      {value}
      {unit ? <span className="text-[0.45em] text-foam-50"> {unit}</span> : null}
    </span>
  );
}

/* — Structure ————————————————————————————————————————————— */

/** The structural unit: a hairline-bordered panel. Never rounded, never
 *  shadowed. Elevation is the border plus a half-stop of background. */
export function Panel({ children, className, tone = 'plain', as: Tag = 'div', ...rest }: {
  children: ReactNode;
  className?: string;
  tone?: 'plain' | 'accent' | 'warn' | 'bad' | 'good';
  as?: 'div' | 'section' | 'article';
} & React.HTMLAttributes<HTMLDivElement>) {
  const tones = {
    plain: 'border-line',
    accent: 'border-line-accent bg-wash-sonar',
    warn: 'border-flare/35 bg-wash-flare',
    bad: 'border-chum/45 bg-wash-chum',
    good: 'border-kelp/40 bg-wash-kelp',
  }[tone];
  return (
    <Tag className={cx('border', tones, className)} {...rest}>
      {children}
    </Tag>
  );
}

/** Cells that share edges with no gap between them. This is the system's
 *  signature structure, lifted straight from the prototype's stat strip. */
export function Seam({ children, className, direction = 'row' }: {
  children: ReactNode;
  className?: string;
  direction?: 'row' | 'col';
}) {
  return (
    <div
      className={cx(
        'flex border border-line',
        direction === 'row' ? 'flex-row [&>*+*]:border-l' : 'flex-col [&>*+*]:border-t',
        '[&>*+*]:border-line',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SeamCell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex-1 px-3 py-2.5', className)}>{children}</div>;
}

/** A section heading with the prototype's rule running off to the right. */
export function SectionRule({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2.5">
      <span className="font-utility text-[11px] font-semibold uppercase tracking-[0.2em] text-foam-50">
        {children}
      </span>
      <span className="h-px flex-1 bg-line" />
      {action}
    </div>
  );
}

/* — Status ————————————————————————————————————————————————— */

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

const TONE_STYLE: Record<Tone, { className: string; glyph: string }> = {
  neutral: { className: 'text-foam-50', glyph: '·' },
  accent: { className: 'text-sonar', glyph: '◆' },
  good: { className: 'text-kelp', glyph: '✓' },
  warn: { className: 'text-flare', glyph: '!' },
  bad: { className: 'text-chum', glyph: '×' },
};

/** Status never relies on colour alone — every chip carries a glyph as well,
 *  per WCAG 2.2 and the design PRD. */
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
        'inline-flex items-center gap-1.5 border border-current px-2 py-[3px]',
        'font-utility text-[10px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap',
        style.className,
        className,
      )}
    >
      {glyph ? <span aria-hidden="true">{style.glyph}</span> : null}
      {children}
    </span>
  );
}

/** A live dot that breathes. Paired with a text label, always. */
export function LiveDot({ tone = 'accent' }: { tone?: Tone }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block h-1.5 w-1.5 animate-breath', {
        accent: 'bg-sonar',
        good: 'bg-kelp',
        warn: 'bg-flare',
        bad: 'bg-chum',
        neutral: 'bg-foam-45',
      }[tone])}
    />
  );
}

export function Bar({ value, max = 100, tone = 'accent', className, height = 'h-1.5', ticks = false }: {
  value: number;
  max?: number;
  tone?: Tone;
  className?: string;
  height?: string;
  ticks?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill = {
    accent: 'bg-sonar',
    good: 'bg-kelp',
    warn: 'bg-flare',
    bad: 'bg-chum',
    neutral: 'bg-foam-45',
  }[tone];
  return (
    <div
      className={cx('relative w-full bg-[var(--sf-data-track)]', height, className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={cx('h-full transition-[width] duration-500', fill)} style={{ width: `${pct}%` }} />
      {ticks ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'repeating-linear-gradient(90deg, var(--sf-abyss) 0 1px, transparent 1px 12px)',
          }}
        />
      ) : null}
    </div>
  );
}

/* — Controls ——————————————————————————————————————————————— */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: 'cta' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  full?: boolean;
};

export function Button({ children, variant = 'outline', size = 'md', full, className, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 cursor-pointer select-none transition-[filter,border-color,color,background] duration-150 disabled:opacity-40 disabled:cursor-not-allowed';

  const sizes = {
    sm: 'min-h-9 px-3 text-[11px]',
    md: 'min-h-11 px-4 text-[12px]',
    lg: 'min-h-14 px-5 text-[16px]',
  }[size];

  const variants = {
    // The notch is the one flourish primary actions carry.
    cta: 'sf-notch border-0 bg-sonar text-on-accent font-display uppercase tracking-[0.12em] hover:brightness-110 active:brightness-95',
    outline:
      'border border-line-strong bg-transparent text-foam font-utility font-semibold uppercase tracking-[0.12em] hover:border-sonar hover:text-sonar',
    ghost:
      'border border-transparent bg-transparent text-sonar font-utility font-semibold uppercase tracking-[0.12em] hover:text-foam',
    danger:
      'border border-chum bg-transparent text-chum font-utility font-semibold uppercase tracking-[0.12em] hover:bg-wash-chum',
  }[variant];

  const ctaSize = variant === 'cta' ? { sm: 'text-[13px]', md: 'text-[15px]', lg: 'text-[18px]' }[size] : '';

  return (
    <button
      type="button"
      className={cx(base, sizes, variants, ctaSize, full && 'w-full', className)}
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
  const describedBy = error ? `${inputId}_err` : hint ? `${inputId}_hint` : undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-50">
        {label}
      </label>
      <input
        id={inputId}
        className="sf-field"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <p id={`${inputId}_err`} className="text-[12px] text-chum">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}_hint`} className="text-[12px] text-foam-50">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Segmented control. Used for the date strip, filter rows, tab switches. */
export function Segmented<T extends string>({ options, value, onChange, className }: {
  options: Array<{ value: T; label: ReactNode; sub?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex border border-line', className)} role="tablist">
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cx(
              'min-h-11 flex-1 cursor-pointer px-2 py-2 font-utility text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors',
              index > 0 && 'border-l border-line',
              active ? 'bg-sonar text-on-accent' : 'text-foam-50 hover:text-foam',
            )}
          >
            <span className="block">{option.label}</span>
            {option.sub ? <span className="mt-0.5 block font-display text-[17px] leading-none">{option.sub}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* — Atmosphere. Used sparingly: sweep only on things acquiring data. —— */

export function Scanlines() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 opacity-[0.16]"
      style={{
        background: 'repeating-linear-gradient(180deg, rgba(120,190,215,.5) 0 1px, transparent 1px 26px)',
      }}
    />
  );
}

export function SonarSweep({ durationSec = 4.6 }: { durationSec?: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-0.5"
      style={{
        background: 'linear-gradient(90deg, transparent, var(--sf-sonar), transparent)',
        animation: `sf-sonar ${durationSec}s linear infinite`,
      }}
    />
  );
}

/* — States ————————————————————————————————————————————————— */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('sf-skeleton', className)} aria-hidden="true" />;
}

/** An empty screen is an invitation to act, not an apology. */
export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Panel className="flex flex-col items-start gap-3 p-5">
      <Display size="sm" as="h3">
        {title}
      </Display>
      <p className="max-w-[38ch] text-[13px] leading-relaxed text-foam-65">{body}</p>
      {action}
    </Panel>
  );
}

/** Errors explain what happened and how to fix it. They do not apologise. */
export function ErrorState({ title, body, onRetry, requestId }: {
  title: string;
  body: string;
  onRetry?: () => void;
  requestId?: string;
}) {
  return (
    <Panel tone="bad" className="flex flex-col items-start gap-3 p-5">
      <div className="flex items-center gap-2 text-chum">
        <span aria-hidden="true" className="font-display text-[15px]">
          ×
        </span>
        <Display size="sm" as="h3">
          {title}
        </Display>
      </div>
      <p className="max-w-[38ch] text-[13px] leading-relaxed text-foam-65">{body}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {requestId ? <p className="font-utility text-[10px] tracking-[0.1em] text-foam-35">Ref {requestId}</p> : null}
    </Panel>
  );
}

/** Permission denial never masquerades as missing data (UX acceptance rule). */
export function PermissionState({ what }: { what: string }) {
  return (
    <Panel className="flex flex-col gap-2 p-5">
      <Label>Not available to you</Label>
      <p className="max-w-[38ch] text-[13px] leading-relaxed text-foam-65">
        {what} is not part of your membership. Reception can tell you what it would take.
      </p>
    </Panel>
  );
}
