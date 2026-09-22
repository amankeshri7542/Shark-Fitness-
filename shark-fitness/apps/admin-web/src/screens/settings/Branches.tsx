import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BranchDetail, BranchState } from '@shark/contracts';
import { ApiError, api, idempotencyKey } from '../../lib/api';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  SelectField,
  Skeleton,
  Toolbar,
  cx,
  type Tone,
} from '../../ui/console';
import { Modal } from '../../ui/overlay';
import BranchPane from './BranchPane';

/* ============================================================================
   The estate.

   A list on the left, one branch open on the right. Not a route per branch:
   configuring a chain is a comparison — "what does Indiranagar do that
   Koramangala does not" — and a screen that makes you go back to ask that is a
   screen that gets answered wrong.

   Below the two-pane breakpoint the list becomes a picker and the pane takes
   the width, because a 375px column split two ways is two unusable columns.
   ========================================================================= */

const STATE_TONE: Record<BranchState, Tone> = {
  draft: 'neutral',
  active: 'good',
  temporarily_closed: 'warn',
  suspended: 'warn',
  archived: 'neutral',
};

export default function Branches({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const branches = useQuery({
    queryKey: ['settings', 'branches'],
    queryFn: () => api<{ items: BranchDetail[] }>('/admin/settings/branches'),
    enabled: canManage,
  });

  if (!canManage) return null;
  if (branches.isLoading) return <Skeleton className="h-96" />;
  if (branches.error || !branches.data) {
    return (
      <ErrorState
        title="Your branches could not be read"
        body={branches.error instanceof ApiError ? branches.error.message : 'The server did not answer.'}
        onRetry={() => void branches.refetch()}
      />
    );
  }

  const all = branches.data.items;
  const visible = showArchived ? all : all.filter((b) => b.state !== 'archived');
  const archivedCount = all.length - all.filter((b) => b.state !== 'archived').length;
  const selected = visible.find((b) => b.id === selectedId) ?? visible[0] ?? null;

  return (
    <>
      <Toolbar>
        <Label>Locations</Label>
        <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-45">
          {visible.length} shown
        </span>
        {archivedCount > 0 ? (
          <Button variant="ghost" onClick={() => setShowArchived((v) => !v)} aria-pressed={showArchived}>
            {showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="cta" onClick={() => setCreating(true)}>
          Add a location
        </Button>
      </Toolbar>

      {visible.length === 0 ? (
        <EmptyState
          title="No locations yet"
          body="Everything else — hours, classes, the door, the till — hangs off a branch."
          action={
            <Button variant="cta" onClick={() => setCreating(true)}>
              Add a location
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-[280px_1fr]">
          <nav aria-label="Locations" className="bg-panel">
            <ul>
              {visible.map((branch) => {
                const active = selected?.id === branch.id;
                return (
                  <li key={branch.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedId(branch.id)}
                      className={cx(
                        'relative flex w-full min-h-11 cursor-pointer flex-col items-start gap-1 border-b border-line-10 px-3.5 py-2.5 text-left transition-colors',
                        active ? 'bg-wash-sonar text-sonar' : 'text-foam-65 hover:bg-wash-sonar-soft hover:text-foam',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cx('absolute inset-y-0 left-0 w-0.5', active ? 'bg-sonar' : 'bg-transparent')}
                      />
                      <span className="flex w-full items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px]">{branch.name}</span>
                        <Chip tone={STATE_TONE[branch.state]}>{branch.state.replace(/_/g, ' ')}</Chip>
                      </span>
                      <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                        {branch.city} · {branch.counts.members} members
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 bg-panel">
            {selected ? <BranchPane key={selected.id} branch={selected} /> : null}
          </div>
        </div>
      )}

      {creating ? (
        <CreateBranchDialog
          onClose={() => setCreating(false)}
          onCreated={(branch) => {
            void queryClient.invalidateQueries({ queryKey: ['settings'] });
            setSelectedId(branch.id);
            setCreating(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Adding a location.
 *
 * Deliberately short: name, where, when it trades. Everything else — hours per
 * day, rooms, overrides — is edited on the branch itself, because a form that
 * asks twenty questions before it will create anything is a form people
 * abandon and then wonder why the gym is not in the list.
 *
 * The new branch is a **draft**. It takes no bookings, no check-ins and no
 * sales until somebody opens it, which is the one thing a half-configured
 * location must not do.
 */
function CreateBranchDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (branch: BranchDetail) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [timezone, setTimezone] = useState('');
  const [capacity, setCapacity] = useState('60');
  const [opensAt, setOpensAt] = useState('06:00');
  const [closesAt, setClosesAt] = useState('22:00');
  const [zoneQuery, setZoneQuery] = useState('');

  const zones = useQuery({
    queryKey: ['settings', 'timezones', zoneQuery],
    queryFn: () => api<{ items: string[] }>(`/admin/settings/timezones?q=${encodeURIComponent(zoneQuery)}`),
  });

  const attempt = idempotencyKey('settings.branch', name.trim(), slug.trim());
  const create = useMutation({
    mutationFn: () =>
      api<{ branch: BranchDetail }>('/admin/settings/branches', {
        method: 'POST',
        idempotencyKey: attempt,
        body: {
          name: name.trim(),
          slug: slug.trim(),
          addressLine: addressLine.trim(),
          city: city.trim(),
          timezone,
          capacity: Number(capacity),
          opensAt,
          closesAt,
        },
      }),
    onSuccess: ({ branch }) => onCreated(branch),
  });

  const zoneOptions = zones.data?.items ?? [];
  const ready = Boolean(name.trim() && slug.trim() && addressLine.trim() && city.trim() && timezone);

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a location"
      kicker="It starts as a draft"
      width="w-[min(680px,100%)]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={!ready}
            pending={create.isPending}
            pendingLabel="Creating…"
            onClick={() => create.mutate()}
          >
            Create as draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[12px] leading-relaxed text-foam-65">
          A new location takes no bookings, check-ins or sales until you open it. Set its hours and rooms first.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Name"
            placeholder="Indiranagar Reef"
            value={name}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              if (!slug) {
                setSlug(
                  e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48),
                );
              }
            }}
          />
          <Field
            label="Short name"
            hint="Lowercase, used in links. Cannot clash with another location."
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Address" placeholder="12th Main, HAL 2nd Stage" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} />
          <Field label="City" placeholder="Bengaluru" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Find a timezone"
            hint="A branch in another city keeps its own clock. Search by city."
            placeholder="dubai, kolkata, london"
            value={zoneQuery}
            onChange={(e) => setZoneQuery(e.target.value)}
          />
          <SelectField
            label="Timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            options={[
              { value: '', label: zoneOptions.length ? 'Choose a timezone' : 'Loading…' },
              ...zoneOptions.slice(0, 200).map((z) => ({ value: z, label: z })),
            ]}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Capacity" type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} hint="People on the floor at once." />
          <Field label="Typically opens" type="time" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
          <Field label="Typically closes" type="time" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
        </div>

        {create.isError ? (
          <p role="alert" className="border border-chum bg-wash-chum px-3 py-2 text-[12px] text-foam-80">
            {create.error instanceof ApiError ? create.error.message : 'That location could not be created.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
