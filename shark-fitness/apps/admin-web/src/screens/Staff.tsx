import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useAdmin, useBranchScope, usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, Display, EmptyState, ErrorState, Field, Panel, PermissionState, Skeleton, Toolbar } from '../ui/console';

interface StaffRow {
  id: string;
  name: string;
  initials: string;
  email: string | null;
  role: string;
  employmentStatus: string;
  branchIds: string[];
  specialties: string[];
  assignedMemberCount: number;
  utilisationPct: number;
}

interface StaffListPayload {
  total: number;
  items: StaffRow[];
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  regional_manager: 'Regional manager',
  branch_manager: 'Branch manager',
  reception: 'Reception',
  trainer: 'Trainer',
  accountant: 'Accountant',
};

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  active: 'good',
  on_leave: 'warn',
  notice: 'warn',
  former: 'bad',
};

export default function StaffScreen() {
  const canView = usePermission('staff.view');
  const canManage = usePermission('staff.manage');
  const { branchId } = useBranchScope();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const query = new URLSearchParams();
  if (search.trim()) query.set('q', search.trim());
  if (role) query.set('role', role);
  if (status) query.set('employmentStatus', status);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['staff', branchId, search, role, status],
    queryFn: () => api<StaffListPayload>(`/admin/staff${query.toString() ? `?${query}` : ''}`, { branchId }),
    enabled: canView,
  });

  if (!canView) {
    return (
      <Page title="Staff">
        <PermissionState what="The staff directory" />
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page title="Staff" kicker="Loading">
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </Page>
    );
  }

  if (error || !data) {
    return (
      <Page title="Staff">
        <ErrorState title="Could not load the directory" body="The API did not answer. Nothing has changed." onRetry={() => void refetch()} />
      </Page>
    );
  }

  return (
    <Page
      title="Staff"
      kicker={`${data.total} in view`}
      actions={
        canManage ? (
          <Button variant="cta" onClick={() => setShowCreate(true)}>
            Add staff
          </Button>
        ) : null
      }
    >
      <Toolbar>
        <Field label="Search" placeholder="Name or email" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[260px]" />
        <div className="flex flex-col gap-1">
          <label className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value)} className="sf-field !min-h-9 !py-2 !text-[13px]">
            <option value="">All roles</option>
            {Object.entries(ROLE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="sf-field !min-h-9 !py-2 !text-[13px]">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="on_leave">On leave</option>
            <option value="notice">Notice</option>
            <option value="former">Former</option>
          </select>
        </div>
      </Toolbar>

      {data.items.length === 0 ? (
        <EmptyState
          title="No staff match this view"
          body={search || role || status ? 'Nothing matches those filters.' : 'Add your first staff member to get started.'}
          action={
            canManage ? (
              <Button variant="cta" onClick={() => setShowCreate(true)}>
                Add staff
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-px overflow-y-auto bg-line md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((s) => (
            <Link key={s.id} to="/staff/$staffId" params={{ staffId: s.id }} className="block bg-hull p-3.5 hover:bg-wash-sonar">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 flex-none place-items-center border border-line-strong font-utility text-[11px] font-semibold">
                  {s.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{s.name}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">{ROLE_LABEL[s.role] ?? s.role}</div>
                </div>
                <Chip tone={STATUS_TONE[s.employmentStatus] ?? 'neutral'}>{s.employmentStatus.replace(/_/g, ' ')}</Chip>
              </div>
              {s.specialties.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.specialties.slice(0, 3).map((sp) => (
                    <Chip key={sp} tone="neutral" glyph={false}>
                      {sp}
                    </Chip>
                  ))}
                </div>
              ) : null}
              {s.role === 'trainer' ? (
                <div className="mt-2 text-[11px] text-foam-45">
                  {s.assignedMemberCount} assigned · {s.utilisationPct}% utilised
                </div>
              ) : null}
            </Link>
          ))}
        </div>
      )}

      {showCreate ? <CreateStaffSheet onClose={() => setShowCreate(false)} /> : null}
    </Page>
  );
}

function CreateStaffSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const branches = useAdmin((s) => s.branches);
  const activeBranchId = useAdmin((s) => s.activeBranchId);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('trainer');
  const [branchId, setBranchId] = useState(activeBranchId ?? branches[0]?.id ?? '');
  const [specialties, setSpecialties] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/admin/staff', {
        method: 'POST',
        body: {
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          role,
          branchIds: branchId ? [branchId] : [],
          specialties: specialties
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
  });

  const submit = (): void => {
    setFieldError(null);
    if (!name.trim()) {
      setFieldError('Name is required.');
      return;
    }
    if (!branchId) {
      setFieldError('Choose a branch.');
      return;
    }
    create.mutate();
  };

  const apiErrorMessage = create.error instanceof ApiError ? create.error.message : create.isError ? 'That did not work.' : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6" onClick={onClose} role="presentation">
      <div
        className="max-h-[85vh] w-[min(520px,100%)] overflow-auto border border-line-strong bg-overlay"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add staff"
      >
        <header className="border-b border-line px-4 py-3">
          <Display size="sm" as="h2">
            Add staff
          </Display>
        </header>
        <div className="flex flex-col gap-3.5 p-4">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 …" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="sf-field !min-h-9 !py-2 !text-[13px]">
                {Object.entries(ROLE_LABEL)
                  .filter(([value]) => value !== 'owner')
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Branch</label>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="sf-field !min-h-9 !py-2 !text-[13px]">
                <option value="">Choose a branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Field
            label="Specialties"
            value={specialties}
            onChange={(e) => setSpecialties(e.target.value)}
            hint="Comma-separated"
            placeholder="Strength, Mobility"
          />
          {fieldError ? (
            <Panel tone="bad">
              <p className="px-3 py-2.5 text-[12px] leading-relaxed">{fieldError}</p>
            </Panel>
          ) : null}
          {apiErrorMessage ? (
            <Panel tone="bad">
              <p className="px-3 py-2.5 text-[12px] leading-relaxed">{apiErrorMessage}</p>
            </Panel>
          ) : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="cta" size="md" disabled={create.isPending} onClick={submit}>
            {create.isPending ? 'Adding…' : 'Add staff'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
