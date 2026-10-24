import { useState, type ReactNode } from 'react';
import type { Consequence, ResolvedSetting } from '@shark/contracts';
import { ApiError } from '../../lib/api';
import { Button, Chip, Label, cx } from '../../ui/console';
import { Modal } from '../../ui/overlay';

/* ============================================================================
   The two things Settings does that no other screen does.

   **Inheritance is shown by asymmetry.** A branch that inherits says so
   quietly — the value, and a line of grey saying where it came from. A branch
   that *overrides* announces it: a cyan edge, a chip, and the gym default
   printed beside the local answer so the operator can see what they changed
   without opening another screen. Silence is the default state on purpose;
   marking both cases equally would make forty settings look like forty
   decisions when thirty-nine of them are the company's.

   **A change that reaches backwards is confirmed against what it does**, not
   against a generic "are you sure". The server answers 409 with the list, the
   dialog renders it, and the operator's confirmation echoes each code back.
   That echo is the mechanism: a warning that was never rendered cannot be
   acknowledged, so this dialog is not decoration over an API that would have
   accepted the call anyway.
   ========================================================================= */

/** Pull the consequence list out of a 409 the settings API answered with. */
export function consequencesOf(error: unknown): Consequence[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details as { consequences?: Consequence[] } | undefined;
  return details?.consequences ?? [];
}

/**
 * Confirms a change by showing exactly what it does to records that exist.
 *
 * A blocking consequence cannot be confirmed at all — the button stays
 * disabled and says what has to happen first. The server enforces the same
 * rule, so this is the explanation rather than the guard.
 */
export function ConsequenceDialog({
  open,
  title,
  intent,
  consequences,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  /** What the operator asked for, in their words. */
  intent: string;
  consequences: Consequence[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (acknowledge: string[]) => void;
}) {
  const blocking = consequences.filter((c) => c.blocking);
  const advisory = consequences.filter((c) => !c.blocking);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      kicker={blocking.length > 0 ? 'Cannot continue yet' : 'Before this is applied'}
      width="w-[min(560px,100%)]"
      footer={
        <>
          {/* Always "Cancel", never "Close": the panel header already has a
              button called Close, and two controls sharing an accessible name
              inside one dialog is ambiguous to anyone not looking at it.
              Cancel is also the truer word — the operator is abandoning a
              change they attempted, whether or not it could have proceeded. */}
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={blocking.length > 0 || pending}
            pending={pending}
            pendingLabel="Applying…"
            onClick={() => onConfirm(advisory.map((c) => c.code))}
          >
            {intent}
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        {blocking.map((c) => (
          <div key={c.code} className="border-b border-line bg-wash-chum px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span aria-hidden="true" className="text-chum">
                ×
              </span>
              <p className="text-[13px] leading-relaxed text-foam-80">{c.message}</p>
            </div>
          </div>
        ))}
        {advisory.map((c) => (
          <div key={c.code} className="border-b border-line px-4 py-3">
            <p className="text-[13px] leading-relaxed text-foam-80">{c.message}</p>
          </div>
        ))}
        {consequences.length === 0 ? (
          <p className="px-4 py-3 text-[13px] leading-relaxed text-foam-65">This change takes effect immediately.</p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * One configurable setting, with where its answer came from.
 *
 * The control is on the right and the provenance underneath, so a column of
 * these reads as a list of values rather than a list of forms.
 */
export function SettingRow({
  setting,
  disabled,
  onChange,
  onInherit,
}: {
  setting: ResolvedSetting;
  disabled: boolean;
  onChange: (value: boolean | number | string) => void;
  onInherit: () => void;
}) {
  const overridden = setting.source === 'branch';

  return (
    <div
      className={cx(
        'flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line px-3.5 py-3',
        // The signature: an override carries a live edge, inheritance does not.
        overridden ? 'border-l-2 border-l-sonar bg-wash-sonar-soft' : 'border-l-2 border-l-transparent',
      )}
    >
      <div className="min-w-[220px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-foam">{setting.label}</span>
          {overridden ? <Chip tone="accent">Overridden here</Chip> : null}
          {!setting.overridable ? <Chip tone="neutral">Whole gym</Chip> : null}
        </div>
        <p className="mt-1 max-w-[62ch] text-[11px] leading-relaxed text-foam-45">{setting.help}</p>
        {overridden ? (
          <p className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
            Gym default: {renderValue(setting.tenantValue, setting.kind)}
          </p>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-2">
        <SettingControl setting={setting} disabled={disabled} onChange={onChange} />
        {overridable(setting) ? (
          <Button variant="ghost" onClick={onInherit} disabled={disabled || !overridden}>
            {overridden ? 'Use gym default' : 'Inherited'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const overridable = (setting: ResolvedSetting): boolean => setting.overridable;

function renderValue(value: ResolvedSetting['value'], kind: ResolvedSetting['kind']): string {
  if (value === null || value === undefined) return 'not set';
  if (kind === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

function SettingControl({
  setting,
  disabled,
  onChange,
}: {
  setting: ResolvedSetting;
  disabled: boolean;
  onChange: (value: boolean | number | string) => void;
}) {
  const locked = disabled || !setting.overridable;

  if (setting.kind === 'boolean') {
    return (
      <label className="flex min-h-9 items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={Boolean(setting.value)}
          disabled={locked}
          aria-label={setting.label}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-foam-65">{setting.value ? 'On' : 'Off'}</span>
      </label>
    );
  }

  if (setting.kind === 'time') {
    return (
      <input
        type="time"
        aria-label={setting.label}
        className="sf-field !min-h-9 !w-auto !py-1.5 !text-[13px]"
        value={String(setting.value ?? '')}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      type="number"
      aria-label={setting.label}
      className="sf-field !min-h-9 !w-24 !py-1.5 !text-[13px]"
      value={Number(setting.value ?? 0)}
      disabled={locked}
      min={0}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/**
 * A section of a settings form with its own save.
 *
 * Settings is not one enormous form with one Save at the bottom: an operator
 * changing the tax number should not be made to re-confirm a currency change
 * they abandoned three fields ago. Each section commits on its own, and says
 * whether it has anything to commit.
 */
export function SettingsSection({
  title,
  description,
  saveLabel,
  dirty,
  pending,
  error,
  onSave,
  onReset,
  children,
}: {
  title: string;
  description: string;
  /** The button's words, where "Save " + the title would not be a sentence. */
  saveLabel?: string;
  dirty: boolean;
  pending: boolean;
  error: string | null;
  onSave: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line" aria-label={title}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line bg-hull px-3.5 py-2.5">
        <h3 className="flex-none font-utility text-[10px] font-semibold uppercase tracking-[0.18em] text-foam-45">
          {title}
        </h3>
        {/* `min-w-0` with a floor: beside a short title the description was
            allotted whatever was left and broke mid-phrase. It now either sits
            on the title's line with room to read, or takes its own. */}
        <p className="min-w-[24ch] max-w-[80ch] flex-1 text-[11px] leading-relaxed text-foam-35">{description}</p>
      </header>

      <div className="flex flex-col gap-3 p-3.5">{children}</div>

      {error ? (
        <p role="alert" className="border-t border-line bg-wash-chum px-3.5 py-2.5 text-[12px] text-foam-80">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-hull px-3.5 py-2.5">
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onReset} disabled={!dirty || pending}>
          Discard
        </Button>
        <Button variant="cta" onClick={onSave} disabled={!dirty || pending} pending={pending} pendingLabel="Saving…">
          {saveLabel ?? `Save ${title.toLowerCase()}`}
        </Button>
      </div>
    </section>
  );
}

/** Local edit state that resets when the server's answer changes underneath it. */
export function useDraft<T extends object>(source: T | undefined): {
  draft: T | undefined;
  set: (patch: Partial<T>) => void;
  reset: () => void;
  dirty: boolean;
} {
  const [override, setOverride] = useState<Partial<T> | null>(null);
  const draft = source ? ({ ...source, ...(override ?? {}) } as T) : undefined;
  return {
    draft,
    set: (patch) => setOverride((prev) => ({ ...(prev ?? {}), ...patch })),
    reset: () => setOverride(null),
    dirty: override !== null && Object.keys(override).length > 0,
  };
}

export { Label };
