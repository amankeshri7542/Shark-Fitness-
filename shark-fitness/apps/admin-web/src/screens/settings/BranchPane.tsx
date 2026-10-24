import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BranchDetail, BranchState, Consequence, DayHours, WeekHours } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import { Button, Chip, Field, Label, Panel, SelectField, Table, TableScroll, TD, TH, THead, TR, cx } from '../../ui/console';
import { ConsequenceDialog, SettingRow, SettingsSection, consequencesOf, useDraft } from './shared';

/* ============================================================================
   One location.

   Ordered by how often it is touched rather than by how the data is shaped:
   its state (rarely, and consequentially), its hours (seasonally), its rooms
   (occasionally), its overrides (rarely), its address (almost never). The
   lifecycle control sits at the top because it is the one thing on this pane
   that changes whether the gym is open.
   ========================================================================= */

const DAYS: Array<{ key: keyof WeekHours; label: string }> = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

/** What the operator is doing, in their words rather than the state machine's. */
const LABEL: Record<BranchState, string> = {
  draft: 'Return to draft',
  active: 'Open this location',
  temporarily_closed: 'Close temporarily',
  suspended: 'Suspend',
  archived: 'Archive permanently',
};

const PLACEHOLDER: Record<BranchState, string> = {
  draft: 'Taking it back off the floor while we re-plan',
  active: 'Fit-out signed off and staffed',
  temporarily_closed: 'Chiller failure, closed until parts arrive',
  suspended: 'Held pending the licence renewal',
  archived: 'Lease not renewed, members moved to Indiranagar',
};

const clockOf = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minutesOf = (v: string): number => {
  const [h, m] = v.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export default function BranchPane({ branch }: { branch: BranchDetail }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ body: Record<string, unknown>; consequences: Consequence[]; kind: 'patch' | 'state' } | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ branch: BranchDetail }>(`/admin/settings/branches/${branch.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      refresh();
      setPending(null);
    },
    onError: (error, body) => {
      const consequences = consequencesOf(error);
      if (consequences.length > 0) setPending({ body, consequences, kind: 'patch' });
    },
  });

  const changeState = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ branch: BranchDetail }>(`/admin/settings/branches/${branch.id}/state`, { method: 'POST', body }),
    onSuccess: () => {
      refresh();
      setPending(null);
    },
    onError: (error, body) => {
      const consequences = consequencesOf(error);
      if (consequences.length > 0) setPending({ body, consequences, kind: 'state' });
    },
  });

  return (
    <>
      <Lifecycle branch={branch} onChange={(body) => changeState.mutate(body)} pending={changeState.isPending} />
      <Identity branch={branch} onSave={(body) => patch.mutate(body)} pending={patch.isPending} error={patch.error} />
      <Hours branch={branch} onSave={(hours) => patch.mutate({ hours })} pending={patch.isPending} />
      <Holidays branch={branch} onSave={(holidays) => patch.mutate({ holidays })} pending={patch.isPending} />
      <Rooms branch={branch} onChanged={refresh} />
      <Overrides branch={branch} onSave={(policy) => patch.mutate({ policy })} pending={patch.isPending} />

      <ConsequenceDialog
        open={pending !== null}
        title="This affects records that already exist"
        intent="Apply anyway"
        consequences={pending?.consequences ?? []}
        pending={patch.isPending || changeState.isPending}
        onCancel={() => setPending(null)}
        onConfirm={(acknowledge) => {
          if (!pending) return;
          const body = { ...pending.body, acknowledge };
          if (pending.kind === 'state') changeState.mutate(body);
          else patch.mutate(body);
        }}
      />
    </>
  );
}

/* ——— Lifecycle (PF-TEN-004) ——————————————————————————— */

function Lifecycle({
  branch,
  onChange,
  pending,
}: {
  branch: BranchDetail;
  onChange: (body: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [target, setTarget] = useState<BranchState | ''>('');
  const [note, setNote] = useState('');

  return (
    <section aria-label="Location state" className="border-b border-line">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 bg-hull px-3.5 py-3">
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-[18px] uppercase leading-none">{branch.name}</h2>
            <Chip tone={branch.trades ? 'good' : 'warn'}>{branch.state.replace(/_/g, ' ')}</Chip>
          </div>
          <p className="mt-1.5 max-w-[70ch] text-[12px] leading-relaxed text-foam-65">{branch.stateMeaning}</p>
          {branch.stateNote ? (
            <p className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
              {branch.stateNote}
              {branch.stateChangedAt ? ` · ${new Date(branch.stateChangedAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}` : ''}
            </p>
          ) : null}
        </div>

        <dl className="flex flex-none flex-wrap gap-x-5 gap-y-1">
          <Count label="Members" value={branch.counts.members} />
          <Count label="Also train here" value={branch.counts.grantedMembers} />
          <Count label="Booked ahead" value={branch.counts.futureBookings} />
          <Count label="Staff" value={branch.counts.staff} />
        </dl>
      </div>

      {branch.nextStates.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-line px-3.5 py-2.5">
          <SelectField
            label="Change state to"
            className="!w-auto"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as BranchState);
              setNote('');
            }}
            options={[
              { value: '', label: 'Leave as it is' },
              ...branch.nextStates.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
            ]}
          />
          {/* The reason and the button appear once there is something to
              justify. Asking "why" beside "leave as it is" invites an answer
              to a question nobody asked. */}
          {target ? (
            <>
              <Field
                label="Why"
                className="min-w-[240px] flex-1"
                hint="Recorded in the audit log against your name."
                placeholder={PLACEHOLDER[target]}
                value={note}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
              />
              <Button
                variant={target === 'archived' ? 'danger' : 'cta'}
                disabled={note.trim().length < 4 || pending}
                pending={pending}
                pendingLabel="Applying…"
                onClick={() => onChange({ state: target, note: note.trim() })}
              >
                {LABEL[target]}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-35">{label}</dt>
      <dd className="mt-0.5 font-display text-[16px] leading-none tabular-nums">{value}</dd>
    </div>
  );
}

/* ——— Identity ————————————————————————————————————————— */

function Identity({
  branch,
  onSave,
  pending,
  error,
}: {
  branch: BranchDetail;
  onSave: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const { draft, set, reset, dirty } = useDraft(branch);
  if (!draft) return null;

  return (
    <SettingsSection
      title="Address and contact"
      description="Where this location is, how members reach it, and the clock it runs on."
      dirty={dirty}
      pending={pending}
      error={error instanceof ApiError && dirty ? error.message : null}
      onReset={reset}
      onSave={() =>
        onSave({
          name: draft.name,
          addressLine: draft.addressLine,
          city: draft.city,
          capacity: draft.capacity,
          phone: draft.phone,
          email: draft.email,
          opensAt: draft.opensAt,
          closesAt: draft.closesAt,
        })
      }
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        <Field label="Capacity" type="number" min={1} hint="People on the floor at once. The door refuses entry above it." value={draft.capacity} onChange={(e) => set({ capacity: Number(e.target.value) })} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Address" value={draft.addressLine} onChange={(e) => set({ addressLine: e.target.value })} />
        <Field label="City" value={draft.city} onChange={(e) => set({ city: e.target.value })} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field label="Phone" value={draft.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
        <Field label="Email" value={draft.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Field label="Typically opens" type="time" hint="Used on any day without its own hours." value={draft.opensAt} onChange={(e) => set({ opensAt: e.target.value })} />
        <Field label="Typically closes" type="time" value={draft.closesAt} onChange={(e) => set({ closesAt: e.target.value })} />
        <div className="flex flex-col gap-1">
          <Label>Timezone</Label>
          <p className="text-[13px] text-foam">{branch.timezone}</p>
          <p className="text-[11px] leading-relaxed text-foam-45">
            Changing this shows recorded times differently. It moves nothing that already happened.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}

/* ——— Hours (PF-TEN-002) ————————————————————————————— */

function Hours({
  branch,
  onSave,
  pending,
}: {
  branch: BranchDetail;
  onSave: (hours: WeekHours | null) => void;
  pending: boolean;
}) {
  const fallback: DayHours = { open: minutesOf(branch.opensAt), close: minutesOf(branch.closesAt), closed: false };
  const [draft, setDraft] = useState<WeekHours | null>(null);
  const [dirty, setDirty] = useState(false);

  const hours = draft ?? branch.hours ?? {};
  const dayOf = (key: keyof WeekHours): { value: DayHours; own: boolean } => {
    const own = hours[key];
    return { value: own ?? fallback, own: Boolean(own) };
  };
  const edit = (key: keyof WeekHours, patch: Partial<DayHours>): void => {
    const current = dayOf(key).value;
    setDraft({ ...hours, [key]: { ...current, ...patch } });
    setDirty(true);
  };

  return (
    <SettingsSection
      title="Opening hours"
      description="The door refuses entry outside these, and classes cannot be scheduled outside them. A day you do not set uses the typical hours above."
      dirty={dirty}
      pending={pending}
      error={null}
      onReset={() => {
        setDraft(null);
        setDirty(false);
      }}
      onSave={() => {
        onSave(Object.keys(hours).length > 0 ? hours : null);
        setDirty(false);
        setDraft(null);
      }}
    >
      <TableScroll>
        <Table label={`Opening hours at ${branch.name}`}>
          <THead>
            <TH>Day</TH>
            <TH>Opens</TH>
            <TH>Closes</TH>
            <TH>Closed all day</TH>
          </THead>
          <tbody>
            {DAYS.map(({ key, label }) => {
              const { value, own } = dayOf(key);
              return (
                <TR key={String(key)}>
                  <TD>
                    <span className="flex items-center gap-2">
                      {label}
                      {own ? null : <Chip tone="neutral">typical</Chip>}
                    </span>
                  </TD>
                  <TD>
                    <input
                      type="time"
                      aria-label={`${label} opens`}
                      className="sf-field !min-h-9 !w-auto !py-1.5 !text-[13px]"
                      value={clockOf(value.open)}
                      disabled={value.closed}
                      onChange={(e) => edit(key, { open: minutesOf(e.target.value) })}
                    />
                  </TD>
                  <TD>
                    <input
                      type="time"
                      aria-label={`${label} closes`}
                      className="sf-field !min-h-9 !w-auto !py-1.5 !text-[13px]"
                      value={clockOf(value.close)}
                      disabled={value.closed}
                      onChange={(e) => edit(key, { close: minutesOf(e.target.value) })}
                    />
                  </TD>
                  <TD>
                    <label className="flex min-h-9 items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        aria-label={`${label} closed all day`}
                        checked={value.closed}
                        onChange={(e) => edit(key, { closed: e.target.checked })}
                      />
                      <span className="text-foam-45">{value.closed ? 'Shut' : 'Open'}</span>
                    </label>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </TableScroll>
      <p className="text-[11px] leading-relaxed text-foam-45">
        A day that runs past midnight closes at 24:00 and opens again the next day — the door reads these as minutes
        within one local day.
      </p>
    </SettingsSection>
  );
}

/* ——— Holidays ————————————————————————————————————————— */

function Holidays({
  branch,
  onSave,
  pending,
}: {
  branch: BranchDetail;
  onSave: (holidays: string[]) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [next, setNext] = useState('');
  const list = draft ?? branch.holidays;

  return (
    <SettingsSection
      title="Holidays"
      description="Days this location is shut regardless of its hours. The door turns members away and says why."
      dirty={draft !== null}
      pending={pending}
      error={null}
      onReset={() => setDraft(null)}
      onSave={() => {
        onSave(list);
        setDraft(null);
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Add a date" type="date" className="!w-auto" value={next} onChange={(e) => setNext(e.target.value)} />
        <Button
          variant="outline"
          disabled={!next || list.includes(next)}
          onClick={() => {
            setDraft([...list, next].sort());
            setNext('');
          }}
        >
          Add
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-[12px] text-foam-45">No holidays set. This location trades on its normal hours all year.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {list.map((day) => (
            <li key={day}>
              <button
                type="button"
                onClick={() => setDraft(list.filter((d) => d !== day))}
                className="flex min-h-9 cursor-pointer items-center gap-2 border border-line px-2.5 font-utility text-[11px] uppercase tracking-[0.1em] text-foam-65 hover:border-chum hover:text-chum"
                aria-label={`Remove ${day}`}
              >
                {day}
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/* ——— Rooms ————————————————————————————————————————— */

function Rooms({ branch, onChanged }: { branch: BranchDetail; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('12');

  const add = useMutation({
    mutationFn: () =>
      api(`/admin/settings/branches/${branch.id}/rooms`, {
        method: 'POST',
        body: { name: name.trim(), capacity: Number(capacity) },
      }),
    onSuccess: () => {
      setName('');
      onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: (roomId: string) => api(`/admin/settings/rooms/${roomId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  return (
    <Panel title="Rooms and areas">
      <div className="flex flex-col gap-3 p-3.5">
        <p className="max-w-[70ch] text-[11px] leading-relaxed text-foam-45">
          A class timetable reads better when it says where, and a room's capacity caps how many can book into it.
        </p>

        {branch.rooms.length === 0 ? (
          <p className="text-[12px] text-foam-45">No rooms yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {branch.rooms.map((room) => (
              <li key={room.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px]">{room.name}</span>
                <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35 tabular-nums">
                  {room.capacity} places
                </span>
                <Button variant="ghost" onClick={() => remove.mutate(room.id)} disabled={remove.isPending}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {remove.isError ? (
          <p role="alert" className="border border-line bg-wash-flare px-3 py-2 text-[12px] leading-relaxed text-foam-80">
            {remove.error instanceof ApiError ? remove.error.message : 'That room could not be removed.'}
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Room name" className="min-w-[200px] flex-1" placeholder="Studio 2" value={name} onChange={(e) => setName(e.target.value)} />
          <Field label="Capacity" type="number" min={1} className="!w-auto" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          <Button variant="outline" disabled={!name.trim() || add.isPending} pending={add.isPending} pendingLabel="Adding…" onClick={() => add.mutate()}>
            Add room
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/* ——— Overrides (PF-TEN-003) ————————————————————————— */

function Overrides({
  branch,
  onSave,
  pending,
}: {
  branch: BranchDetail;
  onSave: (policy: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const dirty = Object.keys(changes).length > 0;

  const settings = branch.settings.map((setting) =>
    Object.prototype.hasOwnProperty.call(changes, setting.key)
      ? {
          ...setting,
          value: (changes[setting.key] ?? setting.tenantValue) as typeof setting.value,
          source: (changes[setting.key] === null ? 'tenant' : 'branch') as typeof setting.source,
        }
      : setting,
  );
  const overridden = settings.filter((s) => s.source === 'branch').length;

  return (
    <SettingsSection
      title="How this location differs"
      description="Everything here follows your gym-wide setting until you change it. A setting you change applies only to this location."
      saveLabel="Save overrides"
      dirty={dirty}
      pending={pending}
      error={null}
      onReset={() => setChanges({})}
      onSave={() => {
        onSave(changes);
        setChanges({});
      }}
    >
      <p className={cx('font-utility text-[10px] uppercase tracking-[0.12em]', overridden > 0 ? 'text-sonar' : 'text-foam-35')}>
        {overridden === 0
          ? 'Everything inherited from gym settings'
          : `${overridden} ${overridden === 1 ? 'setting differs' : 'settings differ'} here`}
      </p>
      <div className="-mx-3.5 border-y border-line">
        {settings.map((setting) => (
          <SettingRow
            key={setting.key}
            setting={setting}
            disabled={pending}
            onChange={(value) => setChanges((prev) => ({ ...prev, [setting.key]: value }))}
            onInherit={() => setChanges((prev) => ({ ...prev, [setting.key]: null }))}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
