import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useAdmin, useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Field, Label, Metric, Panel, PermissionState, Seam, SelectField as ConsoleSelectField, Skeleton, Toolbar, type Tone } from '../ui/console';
import { Modal } from '../ui/overlay';

interface StaffRow { id: string; name: string; initials: string; email: string | null; role: string; employmentStatus: string; branchIds: string[]; specialties: string[]; assignedMemberCount: number; utilisationPct: number; }
interface StaffListPayload { total: number; page: number; pageSize: number; totalPages: number; hasMore: boolean; totals: { active: number; trainers: number; onLeave: number; certificationsNeedingAttention: number }; items: StaffRow[]; }

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', regional_manager: 'Regional manager', branch_manager: 'Branch manager', reception: 'Reception', trainer: 'Trainer', accountant: 'Accountant' };
const STATUS_TONE: Record<string, Tone> = { active: 'good', on_leave: 'warn', notice: 'warn', former: 'bad' };

export default function StaffScreen() {
  const canView = usePermission('staff.view');
  const canManage = usePermission('staff.manage');
  const { branchId } = useBranchScope();
  const branches = useAdmin((state) => state.branches);
  const online = useOnline();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [filterBranch, setFilterBranch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (search.trim()) params.set('q', search.trim());
  if (role) params.set('role', role);
  if (status) params.set('employmentStatus', status);
  if (filterBranch) params.set('branchId', filterBranch);
  const query = useQuery({ queryKey: ['staff', branchId, search, role, status, filterBranch, page], queryFn: () => api<StaffListPayload>(`/admin/staff?${params}`, { branchId }), enabled: canView });

  if (!canView) return <Page title="Staff"><PermissionState what="The staff directory" /></Page>;
  if (query.isLoading) return <Page title="Staff" kicker="Loading"><div className="grid grid-cols-1 gap-px bg-line p-4 md:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-28" />)}</div></Page>;
  if (query.error || !query.data) return <Page title="Staff"><ErrorState title="Could not load the directory" body={!online || query.error instanceof OfflineError ? 'This machine is offline. Reconnect to read staff.' : query.error instanceof ApiError ? query.error.message : 'The API did not answer. Nothing has changed.'} onRetry={() => void query.refetch()} /></Page>;

  const data = query.data;
  const resetPage = (): void => setPage(1);
  return <Page title="Staff" kicker={`${data.total} in scope`} actions={canManage ? <Button variant="cta" onClick={() => setShowCreate(true)} disabled={!online}>Add staff</Button> : null}>
    {!online ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">You are offline. The directory is read-only until the connection returns.</p></Panel> : null}
    <Seam className="border-b border-line"><div className="min-w-[130px] flex-1 px-3.5 py-3"><Label>Active</Label><div className="mt-1.5"><Metric value={data.totals.active} size="md" tone="good" /></div></div><div className="min-w-[130px] flex-1 px-3.5 py-3"><Label>Trainers</Label><div className="mt-1.5"><Metric value={data.totals.trainers} size="md" tone="accent" /></div></div><div className="min-w-[130px] flex-1 px-3.5 py-3"><Label>On leave</Label><div className="mt-1.5"><Metric value={data.totals.onLeave} size="md" tone="warn" /></div></div><div className="min-w-[170px] flex-1 px-3.5 py-3"><Label>Certification attention</Label><div className="mt-1.5"><Metric value={data.totals.certificationsNeedingAttention} size="md" tone={data.totals.certificationsNeedingAttention > 0 ? 'warn' : 'good'} /></div></div></Seam>
    <Toolbar><Field label="Search" placeholder="Name or email" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} className="max-w-[260px]" /><SelectField label="Role" value={role} onChange={(value) => { setRole(value); resetPage(); }} options={[['', 'All roles'], ...Object.entries(ROLE_LABEL).map(([value, label]) => [value, label] as [string, string])]} /><SelectField label="Status" value={status} onChange={(value) => { setStatus(value); resetPage(); }} options={[['', 'Any status'], ['active', 'Active'], ['on_leave', 'On leave'], ['notice', 'Notice'], ['former', 'Former']]} /><SelectField label="Branch" value={filterBranch} onChange={(value) => { setFilterBranch(value); resetPage(); }} options={[['', 'All accessible branches'], ...branches.map((branch) => [branch.id, branch.name] as [string, string])]} /></Toolbar>
    {data.items.length === 0 ? <EmptyState title="No staff match this view" body={search || role || status || filterBranch ? 'Nothing matches those filters.' : 'Add your first staff member to get started.'} action={canManage ? <Button variant="cta" onClick={() => setShowCreate(true)} disabled={!online}>Add staff</Button> : undefined} /> : <div className="grid grid-cols-1 gap-px bg-line md:grid-cols-2 xl:grid-cols-3">{data.items.map((staff) => <Link key={staff.id} to="/staff/$staffId" params={{ staffId: staff.id }} className="block bg-hull p-3.5 hover:bg-wash-sonar"><div className="flex items-center gap-2.5"><span className="grid h-8 w-8 flex-none place-items-center border border-line-strong font-utility text-[11px] font-semibold">{staff.initials}</span><div className="min-w-0 flex-1"><div className="truncate text-[13px]">{staff.name}</div><div className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">{ROLE_LABEL[staff.role] ?? staff.role}</div></div><Chip tone={STATUS_TONE[staff.employmentStatus] ?? 'neutral'}>{staff.employmentStatus.replace(/_/g, ' ')}</Chip></div><div className="mt-2 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{staff.branchIds.map((id) => branches.find((branch) => branch.id === id)?.name ?? id).join(' · ')}</div>{staff.specialties.length > 0 ? <div className="mt-2 flex flex-wrap gap-1">{staff.specialties.slice(0, 3).map((specialty) => <Chip key={specialty} tone="neutral" glyph={false}>{specialty}</Chip>)}</div> : null}{staff.role === 'trainer' ? <div className="mt-2 text-[11px] text-foam-45">{staff.assignedMemberCount} assigned · {staff.utilisationPct}% utilised</div> : null}</Link>)}</div>}
    {data.totalPages > 1 ? <Toolbar className="justify-between"><span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">Page {data.page} of {data.totalPages}</span><div className="flex gap-2"><Button variant="outline" disabled={data.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button><Button variant="outline" disabled={!data.hasMore} onClick={() => setPage((value) => value + 1)}>Next</Button></div></Toolbar> : null}
    {showCreate ? <CreateStaffSheet branches={branches} onClose={() => setShowCreate(false)} /> : null}
  </Page>;
}

function CreateStaffSheet({ branches, onClose }: { branches: Array<{ id: string; name: string }>; onClose: () => void }) {
  const queryClient = useQueryClient();
  const activeBranchId = useAdmin((state) => state.activeBranchId);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState(''); const [role, setRole] = useState('trainer'); const [branchIds, setBranchIds] = useState(activeBranchId ? [activeBranchId] : branches[0] ? [branches[0].id] : []); const [specialties, setSpecialties] = useState(''); const [fieldError, setFieldError] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => api('/admin/staff', { method: 'POST', idempotencyKey: idempotencyKey('staff-invite', email.trim() || name.trim()), body: { name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, role, branchIds, specialties: specialties.split(',').map((value) => value.trim()).filter(Boolean) } }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['staff'] }); onClose(); } });
  const toggle = (id: string): void => setBranchIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const error = create.error instanceof ApiError ? create.error.message : create.isError ? 'That invitation could not be created.' : fieldError;
  return (
    <Modal
      open
      onClose={onClose}
      title="Invite staff"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="cta" pending={create.isPending} pendingLabel="Inviting…" onClick={() => { if (!name.trim()) { setFieldError('Name is required.'); return; } if (branchIds.length === 0) { setFieldError('Choose at least one branch.'); return; } create.mutate(); }}>Invite staff</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4"><Field label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name" autoFocus /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /><Field label="Phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+91 …" /></div><SelectField label="Role" value={role} onChange={setRole} options={Object.entries(ROLE_LABEL).filter(([value]) => value !== 'owner').map(([value, label]) => [value, label] as [string, string])} /><div><Label>Assigned branches</Label><div className="mt-1.5 flex flex-wrap gap-2">{branches.map((branch) => <Button key={branch.id} variant={branchIds.includes(branch.id) ? 'cta' : 'outline'} onClick={() => toggle(branch.id)} aria-pressed={branchIds.includes(branch.id)}>{branch.name}</Button>)}</div></div><Field label="Specialties" value={specialties} onChange={(event) => setSpecialties(event.target.value)} hint="Comma-separated" placeholder="Strength, mobility" />{error ? <Panel tone="bad"><p className="px-3 py-2.5 text-[12px]">{error}</p></Panel> : null}</div>
    </Modal>
  );
}

/* Tuple-shaped call sites, shared control underneath. Three screens each had
   their own byte-identical copy of this select's styling, which is how the
   label gap and control height came to differ by screen. */
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
