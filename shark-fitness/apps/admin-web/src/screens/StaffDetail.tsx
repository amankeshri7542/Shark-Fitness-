import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api } from '../lib/api';
import { useAdmin, useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Metric,
  Panel,
  PermissionState,
  Seam,
  SelectField as ConsoleSelectField,
  Skeleton,
  Toolbar,
  type Tone,
} from '../ui/console';
import { ConfirmDialog as ConsoleConfirmDialog } from '../ui/overlay';
import { useIdempotentAttempt } from '../lib/idempotent-attempt';
import { AccountActivation } from '../ui/AccountActivation';

interface Certification {
  name: string;
  expiresOn: string | null;
  status: 'valid' | 'expiring' | 'expired' | 'no_expiry';
}

interface StaffDetailPayload {
  staff: {
    id: string;
    name: string;
    initials: string;
    email: string | null;
    phone: string | null;
    role: string;
    accountState: 'active' | 'disabled' | 'invited' | string;
    employmentStatus: string;
    branchIds: string[];
    specialties: string[];
    certifications: Certification[];
    hourlyRateMinor: number | null;
    commissionRules: Array<{ kind: string; ratePct: number }>;
    joinedOn: string;
  };
  workload: {
    activeCount: number;
    members: Array<{ assignmentId: string; memberId: string; memberNo: string; name: string; programName: string; currentWeek: number; weeks: number; startsOn: string }>;
  };
  shifts: Array<{ id: string; branchId: string; startsAt: string; endsAt: string; role: string; state: string; conflict: boolean; coveredByStaffId: string | null; note: string | null }>;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  regional_manager: 'Regional manager',
  branch_manager: 'Branch manager',
  reception: 'Reception',
  trainer: 'Trainer',
  accountant: 'Accountant',
};

const STATUS_TONE: Record<string, Tone> = { active: 'good', on_leave: 'warn', notice: 'warn', former: 'bad' };
const ACCOUNT_TONE: Record<string, Tone> = { active: 'good', invited: 'accent', disabled: 'bad' };
const CERT_TONE: Record<string, Tone> = { valid: 'good', expiring: 'warn', expired: 'bad', no_expiry: 'neutral' };

export default function StaffDetailScreen() {
  const { staffId } = useParams({ from: '/console/staff/$staffId' });
  const canView = usePermission('staff.view');
  const canManage = usePermission('staff.manage');
  const isOwner = useAdmin((state) => state.viewer?.role === 'owner');
  const canCommission = usePermission('staff.commission');
  const online = useOnline();
  const queryClient = useQueryClient();
  const { branchName } = useBranchScope();
  const branches = useAdmin((state) => state.branches);
  const [editing, setEditing] = useState(false);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['staff', 'detail', staffId],
    queryFn: () => api<StaffDetailPayload>(`/admin/staff/${staffId}`),
    enabled: canView,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['staff'] });
    void queryClient.invalidateQueries({ queryKey: ['staff', 'detail', staffId] });
  };

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/admin/staff/${staffId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setActionError(null);
      setNotice('Staff profile saved.');
      setEditing(false);
      setShowDeactivate(false);
      invalidate();
    },
    onError: (error) => setActionError(error instanceof ApiError ? error.message : 'That update did not go through.'),
  });

  if (!canView) return <Page title="Staff"><PermissionState what="This staff profile" /></Page>;
  if (detail.isLoading) return <StaffDetailSkeleton />;
  if (detail.error || !detail.data) {
    const body = !online || detail.error instanceof OfflineError ? 'This machine is offline. Reconnect to read the current profile.' : detail.error instanceof ApiError ? detail.error.message : 'The API did not answer. Nothing has changed.';
    return <Page title="Staff"><ErrorState title="Could not load this profile" body={body} onRetry={() => void detail.refetch()} /></Page>;
  }

  const { staff, workload, shifts } = detail.data;
  const branchNames = new Map<string, string>(branches.map((branch) => [branch.id, branch.name]));
  const expiring = staff.certifications.filter((cert) => cert.status === 'expired' || cert.status === 'expiring').length;

  return (
    <Page
      title={staff.name}
      kicker={`${ROLE_LABEL[staff.role] ?? staff.role} · ${branchName}`}
      actions={canManage ? <Button variant={staff.accountState === 'disabled' ? 'cta' : 'danger'} onClick={() => setShowDeactivate(true)}>{staff.accountState === 'disabled' ? 'Activate' : 'Deactivate'}</Button> : null}
    >
      {!online ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">You are offline. The profile is read-only until the connection returns.</p></Panel> : null}
      {notice ? <Panel tone="good" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">{notice}</p></Panel> : null}
      {actionError ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">{actionError}</p></Panel> : null}

      {isOwner ? <AccountActivation key={staffId} staffId={staffId} /> : null}
      <Seam className="border-b border-line">
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Account</Label><div className="mt-1.5"><Chip tone={ACCOUNT_TONE[staff.accountState] ?? 'neutral'}>{staff.accountState}</Chip></div></div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Employment</Label><div className="mt-1.5"><Chip tone={STATUS_TONE[staff.employmentStatus] ?? 'neutral'}>{staff.employmentStatus.replace(/_/g, ' ')}</Chip></div></div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Active clients</Label><div className="mt-1.5"><Metric value={workload.activeCount} size="md" /></div></div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Certifications</Label><div className="mt-1.5"><Metric value={expiring} size="md" tone={expiring > 0 ? 'warn' : 'good'} unit="need attention" /></div></div>
      </Seam>

      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
        <ProfilePanel staff={staff} branches={branches} branchNames={branchNames} canManage={canManage && online} editing={editing} onEdit={() => setEditing(true)} onCancel={() => setEditing(false)} onSave={(body) => update.mutate(body)} isPending={update.isPending} />
        <CertificationPanel certifications={staff.certifications} canManage={canManage && online} onSave={(certifications) => update.mutate({ certifications })} isPending={update.isPending} />
        <ShiftPanel staffId={staffId} shifts={shifts} branchNames={branchNames} canManage={canManage && online} onChanged={invalidate} />
        <CoveragePanel
          staffId={staffId}
          canManage={canManage && online}
          onNotice={(message) => {
            setActionError(null);
            setNotice(message);
          }}
          onError={(error) =>
            setActionError(error instanceof ApiError ? error.message : 'That did not go through. Nothing has changed.')
          }
        />
        <Panel title="Trainer workload" action={<Chip tone="accent">{workload.activeCount} active</Chip>}>
          {workload.members.length === 0 ? <EmptyState title="No active programs" body="This profile has no active training assignments in the current tenant." /> : <div className="divide-y divide-line">{workload.members.map((member) => <Link key={member.assignmentId} to="/members/$memberId" params={{ memberId: member.memberId }} className="flex min-h-11 items-center gap-3 px-3.5 py-2.5 hover:bg-wash-sonar"><div className="min-w-0 flex-1"><div className="truncate text-[13px]">{member.name}</div><div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{member.memberNo} · {member.programName}</div></div><Chip tone="neutral">Week {member.currentWeek}/{member.weeks}</Chip></Link>)}</div>}
        </Panel>
        {canCommission ? <Panel title="Compensation rules"><div className="divide-y divide-line">{staff.commissionRules.length === 0 ? <EmptyState title="No commission rules" body="Add rules only when the tenant's compensation policy supports them." /> : staff.commissionRules.map((rule) => <div key={rule.kind} className="flex items-center justify-between px-3.5 py-2.5 text-[12px]"><span>{rule.kind.replace(/_/g, ' ')}</span><Chip tone="neutral">{rule.ratePct}%</Chip></div>)}</div></Panel> : <Panel title="Compensation rules"><PermissionState what="Compensation details" /></Panel>}
      </div>

      {showDeactivate ? <ConfirmDialog staff={staff} isPending={update.isPending} onClose={() => setShowDeactivate(false)} onConfirm={() => update.mutate({ accountState: staff.accountState === 'disabled' ? 'active' : 'disabled', employmentStatus: staff.accountState === 'disabled' ? 'active' : 'former' })} /> : null}
    </Page>
  );
}

function ProfilePanel({ staff, branches, branchNames, canManage, editing, onEdit, onCancel, onSave, isPending }: { staff: StaffDetailPayload['staff']; branches: Array<{ id: string; name: string }>; branchNames: Map<string, string>; canManage: boolean; editing: boolean; onEdit: () => void; onCancel: () => void; onSave: (body: Record<string, unknown>) => void; isPending: boolean }) {
  const [name, setName] = useState(staff.name);
  const [email, setEmail] = useState(staff.email ?? '');
  const [phone, setPhone] = useState(staff.phone ?? '');
  const [role, setRole] = useState(staff.role);
  const [employmentStatus, setEmploymentStatus] = useState(staff.employmentStatus);
  const [branchIds, setBranchIds] = useState(staff.branchIds);
  const [specialties, setSpecialties] = useState(staff.specialties.join(', '));
  const roleOptions = Object.entries(ROLE_LABEL)
    .filter(([value]) => value !== 'owner' || staff.role === 'owner')
    .map(([value, label]) => [value, label] as [string, string]);

  const toggleBranch = (branchId: string): void => setBranchIds((current) => current.includes(branchId) ? current.filter((id) => id !== branchId) : [...current, branchId]);
  return (
    <Panel title="Profile" action={canManage && !editing ? <Button variant="ghost" onClick={onEdit}>Edit profile</Button> : null}>
      {!editing ? <div className="grid grid-cols-1 gap-3 p-3.5 sm:grid-cols-2"><Info label="Name" value={staff.name} /><Info label="Email" value={staff.email ?? 'Not provided'} /><Info label="Phone" value={staff.phone ?? 'Not provided'} /><Info label="Role" value={ROLE_LABEL[staff.role] ?? staff.role} /><Info label="Branches" value={staff.branchIds.map((id) => branchNames.get(id) ?? id).join(', ')} /><Info label="Specialties" value={staff.specialties.join(', ') || 'None recorded'} /><Info label="Joined" value={staff.joinedOn} /><Info label="Account" value={staff.accountState} /></div> : <div className="flex flex-col gap-3 p-3.5"><Field label="Name" value={name} onChange={(event) => setName(event.target.value)} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /><Field label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><SelectField label="Role" value={role} onChange={setRole} options={roleOptions} /><SelectField label="Employment" value={employmentStatus} onChange={setEmploymentStatus} options={['active', 'on_leave', 'notice', 'former'].map((value) => [value, value.replace(/_/g, ' ')] as [string, string])} /></div><div><Label>Branches</Label><div className="mt-1.5 flex flex-wrap gap-2">{branches.map((branch) => <Button key={branch.id} variant={branchIds.includes(branch.id) ? 'cta' : 'outline'} onClick={() => toggleBranch(branch.id)} aria-pressed={branchIds.includes(branch.id)}>{branch.name}</Button>)}</div></div><Field label="Specialties" value={specialties} onChange={(event) => setSpecialties(event.target.value)} hint="Comma-separated" /><Toolbar className="-mx-3.5 border-y"><Button variant="ghost" onClick={onCancel}>Cancel</Button><Button variant="cta" disabled={isPending || branchIds.length === 0} onClick={() => onSave({ name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, role, employmentStatus, branchIds, specialties: specialties.split(',').map((value) => value.trim()).filter(Boolean) })}>{isPending ? 'Saving…' : 'Save profile'}</Button></Toolbar></div>}
    </Panel>
  );
}

function CertificationPanel({ certifications, canManage, onSave, isPending }: { certifications: Certification[]; canManage: boolean; onSave: (certifications: Array<{ name: string; expiresOn: string | null }>) => void; isPending: boolean }) {
  const [name, setName] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const add = (): void => { if (!name.trim()) return; onSave([...certifications.map(({ status: _status, ...cert }) => cert), { name: name.trim(), expiresOn: expiresOn || null }]); setName(''); setExpiresOn(''); };
  return <Panel title="Certifications" action={<Chip tone={certifications.some((cert) => cert.status === 'expired') ? 'bad' : certifications.some((cert) => cert.status === 'expiring') ? 'warn' : 'good'}>{certifications.length} recorded</Chip>}><div className="divide-y divide-line">{certifications.length === 0 ? <EmptyState title="No certifications recorded" body="Add credentials only when the underlying certificate is available." /> : certifications.map((cert) => <div key={`${cert.name}-${cert.expiresOn ?? 'none'}`} className="flex items-center gap-3 px-3.5 py-2.5"><div className="min-w-0 flex-1"><div className="text-[12px]">{cert.name}</div><div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{cert.expiresOn ? `Expires ${cert.expiresOn}` : 'No expiry recorded'}</div></div><Chip tone={CERT_TONE[cert.status] ?? 'neutral'}>{cert.status.replace(/_/g, ' ')}</Chip></div>)}</div>{canManage ? <div className="grid grid-cols-1 gap-2 border-t border-line p-3.5 sm:grid-cols-[1fr_150px_auto]"><Field label="Certificate" value={name} onChange={(event) => setName(event.target.value)} placeholder="First aid" /><Field label="Expiry" type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} /><Button variant="outline" disabled={isPending || !name.trim()} onClick={add}>Add</Button></div> : null}</Panel>;
}

function ShiftPanel({ staffId, shifts, branchNames, canManage, onChanged }: { staffId: string; shifts: StaffDetailPayload['shifts']; branchNames: Map<string, string>; canManage: boolean; onChanged: () => void }) {
  const [branchId, setBranchId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [role, setRole] = useState('floor');
  const [error, setError] = useState<string | null>(null);
  const branches = useAdmin((state) => state.branches);
  const attempt = useIdempotentAttempt('staff-shift', staffId);
  const create = useMutation({
    mutationFn: () => {
      const payload = { branchId, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), role, note: null };
      return api(`/admin/staff/${staffId}/shifts`, { method: 'POST', idempotencyKey: attempt.keyFor(payload), body: payload });
    },
    onSuccess: () => { attempt.retire(); setError(null); setStartsAt(''); setEndsAt(''); onChanged(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'That shift could not be saved.'),
  });
  return <Panel title="Shifts and availability"><div className="divide-y divide-line">{shifts.length === 0 ? <EmptyState title="No shifts in this window" body="Add a planned shift to make availability visible to the team." /> : shifts.map((shift) => <div key={shift.id} className="flex items-center gap-3 px-3.5 py-2.5"><div className="min-w-0 flex-1"><div className="text-[12px]">{new Date(shift.startsAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} – {new Date(shift.endsAt).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</div><div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{branchNames.get(shift.branchId) ?? shift.branchId} · {shift.role}</div></div><Chip tone={shift.conflict ? 'bad' : shift.state === 'completed' ? 'good' : 'neutral'}>{shift.conflict ? 'overlap' : shift.state.replace(/_/g, ' ')}</Chip></div>)}</div>{canManage ? <div className="grid grid-cols-1 gap-2 border-t border-line p-3.5 sm:grid-cols-2"><SelectField label="Branch" value={branchId} onChange={setBranchId} options={[['', 'Choose branch'], ...branches.map((branch) => [branch.id, branch.name] as [string, string])]} /><Field label="Shift role" value={role} onChange={(event) => setRole(event.target.value)} /><Field label="Starts" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /><Field label="Ends" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /><div className="sm:col-span-2">{error ? <p className="mb-2 text-[11px] text-chum">{error}</p> : null}<Button variant="outline" disabled={create.isPending || !branchId || !startsAt || !endsAt} onClick={() => create.mutate()}>{create.isPending ? 'Adding…' : 'Add shift'}</Button></div></div> : null}</Panel>;
}

function ConfirmDialog({ staff, isPending, onClose, onConfirm }: { staff: StaffDetailPayload['staff']; isPending: boolean; onClose: () => void; onConfirm: () => void }) {
  const disabling = staff.accountState !== 'disabled';
  return (
    <ConsoleConfirmDialog
      open
      onClose={onClose}
      onConfirm={onConfirm}
      title={disabling ? 'Deactivate staff account?' : 'Activate staff account?'}
      consequence={
        disabling
          ? `${staff.name} will no longer be able to sign in. Their employment record and training history remain available.`
          : `${staff.name} will be able to sign in again. Confirm their employment status separately if they are returning from leave.`
      }
      confirmLabel={disabling ? 'Deactivate' : 'Activate'}
      tone={disabling ? 'danger' : 'cta'}
      pending={isPending}
    />
  );
}

/* Tuple-shaped call sites, the shared control underneath. This screen carried
   its own label-and-select pair, which is how the gap under a label and the
   height of a control came to differ from the rest of the console. */
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return (
    <ConsoleSelectField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel }))}
    />
  );
}
function Info({ label, value }: { label: string; value: string }) { return <div><Label>{label}</Label><p className="mt-1 text-[13px] leading-relaxed text-foam-80">{value}</p></div>; }
function StaffDetailSkeleton() { return <Page title="Staff" kicker="Loading"><div className="grid grid-cols-1 gap-px bg-line p-4 md:grid-cols-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-48" />)}</div></Page>; }

/* ============================================================================
   Coverage — PF-STAFF.

   Recording an absence changes nothing about anybody's booking, and this panel
   is built to make that obvious: the absence and the damage it causes are two
   separate readings, and every class stays exactly where it was until somebody
   decides otherwise.
   ========================================================================= */

interface CoverageImpact {
  sessions: Array<{
    sessionId: string;
    className: string;
    branchId: string;
    startsAt: number;
    localDate: string;
    booked: number;
    capacity: number;
  }>;
  appointments: Array<{
    appointmentId: string;
    memberId: string;
    memberName: string;
    startsAt: number;
    kind: string;
  }>;
  shifts: Array<{ shiftId: string; startsAt: number; endsAt: number; role: string }>;
}

interface Absence {
  id: string;
  startsAt: number;
  endsAt: number;
  reason: string;
  note: string | null;
  state: string;
}

interface SubstituteCandidate {
  staffId: string;
  name: string;
  eligible: boolean;
  blockedReason: string | null;
  matchingSpecialties: string[];
  expiredCertifications: string[];
  sessionsThatDay: number;
}

const REASON_LABEL: Record<string, string> = {
  sick: 'Off sick',
  leave: 'On leave',
  training: 'Training',
  other: 'Unavailable',
};

function CoveragePanel({
  staffId,
  canManage,
  onNotice,
  onError,
}: {
  staffId: string;
  canManage: boolean;
  onNotice: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const { branchId } = useBranchScope();
  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [reason, setReason] = useState('sick');
  const [note, setNote] = useState('');
  const [coveringSessionId, setCoveringSessionId] = useState<string | null>(null);

  const absences = useQuery({
    queryKey: ['staff', staffId, 'unavailability'],
    queryFn: () => api<{ unavailability: Absence[] }>(`/admin/staff/${staffId}/unavailability`, { branchId }),
  });

  const impact = useQuery({
    queryKey: ['staff', staffId, 'coverage'],
    queryFn: () => api<CoverageImpact>(`/admin/staff/${staffId}/coverage`, { branchId }),
  });

  const attempt = useIdempotentAttempt('admin-unavailability', staffId);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['staff', staffId] });
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
  };

  const mark = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ impact: CoverageImpact }>(`/admin/staff/${staffId}/unavailability`, {
        method: 'POST',
        body,
        branchId,
        idempotencyKey: attempt.keyFor(body),
      }),
    onSuccess: (result) => {
      attempt.retire();
      setAdding(false);
      setNote('');
      const n = result.impact.sessions.length;
      const a = result.impact.appointments.length;
      onNotice(
        `Absence recorded. ${n} ${n === 1 ? 'class' : 'classes'} and ${a} ${a === 1 ? 'appointment' : 'appointments'} ` +
          'are affected. Nothing has been moved — assign cover below when you are ready.',
      );
      refresh();
    },
    onError,
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/admin/staff/unavailability/${id}`, { method: 'DELETE', branchId }),
    onSuccess: () => {
      onNotice('Availability restored. Cover already assigned stays as it is — those members were told once already.');
      refresh();
    },
    onError,
  });

  const live = (absences.data?.unavailability ?? []).filter((row) => row.state === 'active');

  return (
    <Panel
      title="Availability and cover"
      action={
        canManage ? (
          <Button variant="ghost" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : 'Mark unavailable'}
          </Button>
        ) : null
      }
    >
      {adding ? (
        <div className="border-b border-line bg-wash-sonar-soft p-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            <Field label="Until" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            <SelectField
              label="Reason"
              value={reason}
              onChange={setReason}
              options={[
                ['sick', 'Off sick'],
                ['leave', 'On leave'],
                ['training', 'Training'],
                ['other', 'Other'],
              ]}
            />
          </div>
          <Field
            label="Note"
            className="mt-3"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional — visible to managers only"
          />
          <Toolbar className="mt-3 -mx-3.5 -mb-3.5 border-t">
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              variant="cta"
              disabled={mark.isPending || to <= from}
              onClick={() =>
                mark.mutate({
                  startsAt: new Date(`${from}T00:00:00`).toISOString(),
                  endsAt: new Date(`${to}T00:00:00`).toISOString(),
                  reason,
                  note: note.trim() || null,
                })
              }
            >
              {mark.isPending ? 'Recording…' : 'Record absence'}
            </Button>
          </Toolbar>
        </div>
      ) : null}

      {live.length === 0 ? (
        <EmptyState title="Available" body="No absence is recorded for this profile." />
      ) : (
        <div className="divide-y divide-line">
          {live.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <Chip tone="warn">{REASON_LABEL[row.reason] ?? row.reason}</Chip>
              <div className="min-w-0 flex-1 text-[12px]">
                {new Date(row.startsAt).toLocaleDateString()} → {new Date(row.endsAt).toLocaleDateString()}
                {row.note ? <span className="text-foam-45"> · {row.note}</span> : null}
              </div>
              {canManage ? (
                <Button variant="ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate(row.id)}>
                  Restore availability
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line px-3.5 py-2.5">
        <Label>Affected in the next four weeks</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-foam-45">
          Nothing here has been changed. Classes can be covered by another coach; one-to-one appointments are listed
          because the member chose this trainer, and moving them is a conversation rather than a button.
        </p>
      </div>

      {impact.isLoading ? (
        <Skeleton className="h-24" />
      ) : impact.data && impact.data.sessions.length + impact.data.appointments.length === 0 ? (
        <EmptyState title="Nothing affected" body="No classes or appointments fall inside a recorded absence." />
      ) : (
        <div className="divide-y divide-line">
          {(impact.data?.sessions ?? []).map((row) => (
            <div key={row.sessionId}>
              <div className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{row.className}</div>
                  <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    {row.localDate} · {row.booked}/{row.capacity} booked
                  </div>
                </div>
                {canManage ? (
                  <Button
                    variant="outline"
                    onClick={() => setCoveringSessionId(coveringSessionId === row.sessionId ? null : row.sessionId)}
                  >
                    {coveringSessionId === row.sessionId ? 'Close' : 'Find cover'}
                  </Button>
                ) : null}
              </div>
              {coveringSessionId === row.sessionId ? (
                <SubstitutePicker
                  sessionId={row.sessionId}
                  branchId={branchId}
                  onAssigned={(name) => {
                    setCoveringSessionId(null);
                    onNotice(`${name} is covering. Everyone booked in has been told, and nobody's seat moved.`);
                    refresh();
                  }}
                  onError={onError}
                />
              ) : null}
            </div>
          ))}
          {(impact.data?.appointments ?? []).map((row) => (
            <div key={row.appointmentId} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {row.memberName} <span className="text-foam-45">· {row.kind.replace(/_/g, ' ')}</span>
                </div>
                <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                  {new Date(row.startsAt).toLocaleString()}
                </div>
              </div>
              <Chip tone="warn">Needs a conversation</Chip>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Who could take this class, and who could not, with the reason.
 *
 *  Ineligible coaches are shown rather than filtered out: "why is Priya not in
 *  this list" is the question a manager asks next, and answering it here saves
 *  the trip to her profile. */
function SubstitutePicker({
  sessionId,
  branchId,
  onAssigned,
  onError,
}: {
  sessionId: string;
  branchId: string | null;
  onAssigned: (name: string) => void;
  onError: (err: unknown) => void;
}) {
  const candidates = useQuery({
    queryKey: ['schedule', 'substitutes', sessionId],
    queryFn: () =>
      api<{ candidates: SubstituteCandidate[] }>(`/admin/schedule/session/${sessionId}/substitutes`, { branchId }),
  });

  const assign = useMutation({
    mutationFn: (candidate: SubstituteCandidate) =>
      api(`/admin/schedule/session/${sessionId}/substitute`, {
        method: 'POST',
        body: { trainerId: candidate.staffId },
        branchId,
      }).then(() => candidate.name),
    onSuccess: onAssigned,
    onError,
  });

  if (candidates.isLoading) return <Skeleton className="h-20" />;
  if (!candidates.data) return null;

  return (
    <div className="border-t border-line bg-wash-sonar-soft">
      {candidates.data.candidates.length === 0 ? (
        <EmptyState title="No other coaches" body="This branch has no other trainer on the books." />
      ) : (
        <div className="divide-y divide-line">
          {candidates.data.candidates.map((candidate) => (
            <div key={candidate.staffId} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px]">{candidate.name}</div>
                <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                  {candidate.eligible
                    ? `${candidate.matchingSpecialties.length > 0 ? candidate.matchingSpecialties.join(', ') : 'No matching speciality'} · ${candidate.sessionsThatDay} classes that day`
                    : candidate.blockedReason}
                </div>
                {candidate.expiredCertifications.length > 0 ? (
                  <div className="mt-1 text-[11px] text-signal-warn">
                    Lapsed: {candidate.expiredCertifications.join(', ')}
                  </div>
                ) : null}
              </div>
              <Button
                variant={candidate.eligible ? 'cta' : 'outline'}
                disabled={!candidate.eligible || assign.isPending}
                onClick={() => assign.mutate(candidate)}
              >
                {candidate.eligible ? 'Assign cover' : 'Unavailable'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
