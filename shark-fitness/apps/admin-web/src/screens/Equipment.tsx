import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useAdmin, useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import { Button, Chip, Display, EmptyState, ErrorState, Field, Label, Metric, Panel, PermissionState, Seam, Skeleton, Toolbar, type Tone } from '../ui/console';

interface EquipmentRow {
  id: string;
  name: string;
  assetTag: string;
  qrIdentifier: string;
  branchId: string;
  branchName: string;
  area: string;
  model: string;
  serial: string;
  vendor: string;
  warrantyUntil: string | null;
  status: string;
  lastServicedOn: string | null;
  serviceIntervalDays: number;
  nextServiceDue: string | null;
  overdue: boolean;
  openWorkOrders: number;
  downtimeDays30: number;
  outOfService: boolean;
  safetyHold: boolean;
  returnBlockedReason: string | null;
}

interface WorkOrderRow {
  id: string;
  reference: string;
  equipmentId: string | null;
  equipmentName: string | null;
  branchId: string;
  branchName: string;
  title: string;
  description: string;
  severity: string;
  state: string;
  reportedByName: string;
  reportedByKind: string;
  assigneeId: string | null;
  assigneeName: string | null;
  costMinor: number;
  openedAt: string;
  closedAt: string | null;
  duplicateOfId: string | null;
  restricted: boolean;
  overdue: boolean;
  needsReassignment: boolean;
}

interface FacilityTaskRow {
  id: string;
  branchId: string;
  branchName: string;
  title: string;
  cadence: string;
  nextDueAt: string;
  branchState: string;
  overdue: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  state: string;
  checklist: string[];
  lastCompletedAt: string | null;
}

interface Metrics {
  equipmentTotal: number;
  available: number;
  inMaintenance: number;
  outOfService: number;
  retired: number;
  overdueMaintenance: number;
  openWorkOrders: number;
  safetyIssues: number;
  recurringFaults: number;
  maintenanceCostMinor: number;
  maintenanceCost30dMinor: number;
  downtimeDays30: number;
  completedWorkOrders: number;
  workOrderCompletionPct: number;
  totalTasks: number;
  completedTasks: number;
  taskCompletionPct: number;
}

interface FacilityPayload {
  metrics: Metrics;
  equipment: EquipmentRow[];
  workOrders: WorkOrderRow[];
  tasks: FacilityTaskRow[];
}

interface Assignee {
  id: string;
  name: string;
}

const STATUS_TONE: Record<string, Tone> = {
  available: 'good',
  in_maintenance: 'warn',
  out_of_service: 'bad',
  retired: 'neutral',
};

const SEVERITY_TONE: Record<string, Tone> = {
  low: 'neutral',
  medium: 'warn',
  high: 'bad',
  safety: 'bad',
};

const STATE_TONE: Record<string, Tone> = {
  open: 'warn',
  assigned: 'accent',
  in_progress: 'accent',
  blocked: 'bad',
  done: 'good',
  cancelled: 'neutral',
  skipped: 'neutral',
};

const DAY = 24 * 60 * 60 * 1000;

export default function EquipmentScreen() {
  const canView = usePermission('facility.view');
  const canManage = usePermission('facility.manage');
  const { branchId, branchName } = useBranchScope();
  const branches = useAdmin((state) => state.branches);
  const online = useOnline();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [workOrderState, setWorkOrderState] = useState('');
  const [severity, setSeverity] = useState('');
  const [showEquipmentForm, setShowEquipmentForm] = useState(false);
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);

  const params = new URLSearchParams({ limit: '250' });
  if (search.trim()) params.set('q', search.trim());
  if (status) params.set('status', status);
  if (workOrderState) params.set('workOrderState', workOrderState);
  if (severity) params.set('severity', severity);

  const facility = useQuery({
    queryKey: ['facility', branchId, search, status, workOrderState, severity],
    queryFn: () => api<FacilityPayload>(`/admin/facility?${params.toString()}`, { branchId }),
    enabled: canView,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['facility'] });
  };

  const updateWorkOrder = useMutation({
    mutationFn: ({ workOrderId, resolutionNote }: { workOrderId: string; resolutionNote: string }) => api(`/admin/facility/work-orders/${workOrderId}`, { method: 'PATCH', body: { state: 'done', resolutionNote } }),
    onSuccess: refresh,
  });

  const completeTask = useMutation({
    mutationFn: (taskId: string) => api(`/admin/facility/tasks/${taskId}`, { method: 'PATCH', body: { state: 'done' } }),
    onSuccess: refresh,
  });

  const [returningEquipment, setReturningEquipment] = useState<EquipmentRow | null>(null);

  if (!canView) {
    return (
      <Page title="Equipment">
        <PermissionState what="Equipment and facility operations" />
      </Page>
    );
  }

  if (facility.isLoading) {
    return (
      <Page title="Equipment" kicker="Loading">
        <div className="grid grid-cols-1 gap-px bg-line p-4 md:grid-cols-2">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-48" />)}
        </div>
      </Page>
    );
  }

  if (facility.error || !facility.data) {
    const body = !online || facility.error instanceof OfflineError ? 'This machine is offline. Reconnect to read facility operations.' : facility.error instanceof ApiError ? facility.error.message : 'The API did not answer. Nothing has changed.';
    return <Page title="Equipment"><ErrorState title="Could not load facility operations" body={body} onRetry={() => void facility.refetch()} /></Page>;
  }

  const data = facility.data;
  const actionError = updateWorkOrder.error ?? completeTask.error;

  return (
    <Page
      title="Equipment"
      kicker={`${branchName} · ${data.metrics.equipmentTotal} assets`}
      actions={
        canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowTaskForm(true)} disabled={!online}>New task</Button>
            <Button variant="outline" onClick={() => setShowIssueForm(true)} disabled={!online}>Report issue</Button>
            <Button variant="cta" onClick={() => setShowEquipmentForm(true)} disabled={!online}>Add equipment</Button>
          </div>
        ) : null
      }
    >
      {!online ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">You are offline. Facility data is read-only until the connection returns.</p></Panel> : null}
      {actionError ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">{actionError instanceof ApiError ? actionError.message : 'That facility update could not be saved.'}</p></Panel> : null}

      <Seam className="flex-wrap border-b border-line">
        <MetricCell label="Assets" value={data.metrics.equipmentTotal} detail={`${data.metrics.available} available`} tone="accent" />
        <MetricCell label="Open work" value={data.metrics.openWorkOrders} detail={`${data.metrics.safetyIssues} safety`} tone={data.metrics.safetyIssues > 0 ? 'bad' : 'warn'} />
        <MetricCell label="Overdue service" value={data.metrics.overdueMaintenance} detail="Due date passed" tone={data.metrics.overdueMaintenance > 0 ? 'warn' : 'good'} />
        <MetricCell label="Downtime · 30 days" value={data.metrics.downtimeDays30} detail="Equipment days" tone={data.metrics.downtimeDays30 > 0 ? 'warn' : 'good'} />
        <MetricCell label="Maintenance cost" value={formatMinor(data.metrics.maintenanceCost30dMinor)} detail="Opened in 30 days" tone="default" />
        <MetricCell label="Task completion" value={`${data.metrics.taskCompletionPct}%`} detail={`${data.metrics.completedTasks}/${data.metrics.totalTasks} tasks`} tone={data.metrics.taskCompletionPct >= 80 ? 'good' : 'warn'} />
      </Seam>

      <Toolbar>
        <Field label="Search" placeholder="Asset, area or work order" value={search} onChange={(event) => setSearch(event.target.value)} className="max-w-[260px]" />
        <SelectField label="Asset status" value={status} onChange={setStatus} options={[['', 'All assets'], ['available', 'Available'], ['in_maintenance', 'In maintenance'], ['out_of_service', 'Out of service'], ['retired', 'Retired']]} />
        <SelectField label="Work state" value={workOrderState} onChange={setWorkOrderState} options={[['', 'All work'], ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done'], ['cancelled', 'Cancelled']]} />
        <SelectField label="Severity" value={severity} onChange={setSeverity} options={[['', 'All severity'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['safety', 'Safety']]} />
      </Toolbar>

      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-[1.2fr_1fr]">
        <Panel title={`Equipment registry · ${data.equipment.length}`} className="bg-hull">
          {data.equipment.length === 0 ? (
            <EmptyState title="No equipment in this view" body={search || status ? 'Nothing matches these filters.' : 'Add the first asset to start the registry.'} action={canManage ? <Button variant="cta" onClick={() => setShowEquipmentForm(true)} disabled={!online}>Add equipment</Button> : undefined} />
          ) : (
            <div className="overflow-x-auto">
              <table className="console-table">
                <thead><tr><th>Asset</th><th>Location</th><th>Service</th><th>Open work</th><th>Status</th></tr></thead>
                <tbody>
                  {data.equipment.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <div className="font-utility text-[12px] font-semibold">{item.name}</div>
                        <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{item.assetTag} · QR ready</div>
                        <div className="mt-1 text-[11px] text-foam-45">{item.model || 'Model not recorded'}{item.serial ? ` · ${item.serial}` : ''}</div>
                      </td>
                      <td><div className="text-[12px]">{item.area}</div><div className="text-[11px] text-foam-35">{item.branchName}</div></td>
                      <td>
                        <div className="text-[11px] text-foam-65">{item.nextServiceDue ? `Due ${dateLabel(item.nextServiceDue)}` : 'No date recorded'}</div>
                        {item.overdue ? <Chip tone="warn" className="mt-1">overdue</Chip> : <Chip tone="good" className="mt-1">on schedule</Chip>}
                      </td>
                      <td className="font-display text-[16px] tabular-nums">{item.openWorkOrders}</td>
                      <td>
                        <Chip tone={STATUS_TONE[item.status] ?? 'neutral'}>{item.status.replace(/_/g, ' ')}</Chip>
                        {item.safetyHold ? <Chip tone="bad" className="mt-1">safety hold</Chip> : null}
                        {item.outOfService ? (
                          <div className="mt-1.5">
                            {item.returnBlockedReason ? (
                              <div className="text-[10px] leading-snug text-foam-45">{item.returnBlockedReason}</div>
                            ) : canManage ? (
                              <Button variant="outline" onClick={() => setReturningEquipment(item)} disabled={!online}>Return to service</Button>
                            ) : (
                              <div className="text-[10px] leading-snug text-foam-45">A manager must return this asset to service.</div>
                            )}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title={`Work orders · ${data.workOrders.length}`} action={canManage ? <Button variant="ghost" onClick={() => setShowIssueForm(true)} disabled={!online}>Report issue</Button> : null} className="bg-hull">
          {data.workOrders.length === 0 ? <EmptyState title="No work orders" body="Reported equipment and facility issues will appear here." action={canManage ? <Button variant="outline" onClick={() => setShowIssueForm(true)} disabled={!online}>Report issue</Button> : undefined} /> : <div className="divide-y divide-line">{data.workOrders.map((order) => <WorkOrderCard key={order.id} order={order} canManage={canManage} online={online} isPending={updateWorkOrder.isPending && updateWorkOrder.variables?.workOrderId === order.id} onComplete={(resolutionNote) => updateWorkOrder.mutate({ workOrderId: order.id, resolutionNote })} />)}</div>}
        </Panel>
      </div>

      <Panel title={`Facility tasks · ${data.tasks.length}`} action={canManage ? <Button variant="ghost" onClick={() => setShowTaskForm(true)} disabled={!online}>New task</Button> : null} className="border-t border-line bg-hull">
        {data.tasks.length === 0 ? <EmptyState title="No facility tasks" body="Create an opening, cleaning or safety checklist to give the floor a clear next action." action={canManage ? <Button variant="cta" onClick={() => setShowTaskForm(true)} disabled={!online}>New task</Button> : undefined} /> : <div className="grid grid-cols-1 gap-px bg-line md:grid-cols-2 xl:grid-cols-3">{data.tasks.map((task) => <TaskCard key={task.id} task={task} canManage={canManage} online={online} isPending={completeTask.isPending && completeTask.variables === task.id} onComplete={() => completeTask.mutate(task.id)} />)}</div>}
      </Panel>

      {showEquipmentForm ? <CreateEquipmentDialog branches={branches} activeBranchId={branchId} online={online} onClose={() => setShowEquipmentForm(false)} /> : null}
      {showIssueForm ? <CreateIssueDialog equipment={data.equipment} branches={branches} activeBranchId={branchId} online={online} onClose={() => setShowIssueForm(false)} /> : null}
      {showTaskForm ? <CreateTaskDialog branches={branches} activeBranchId={branchId} online={online} onClose={() => setShowTaskForm(false)} /> : null}
      {returningEquipment ? <ReturnToServiceDialog equipment={returningEquipment} online={online} onClose={() => setReturningEquipment(null)} /> : null}
    </Page>
  );
}

function MetricCell({ label, value, detail, tone }: { label: string; value: ReactNode; detail: string; tone: 'default' | 'accent' | 'good' | 'warn' | 'bad' }) {
  return <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>{label}</Label><div className="mt-1.5"><Metric value={value} size="md" tone={tone} /></div><div className="mt-1 text-[10px] text-foam-35">{detail}</div></div>;
}

function WorkOrderCard({ order, canManage, online, isPending, onComplete }: { order: WorkOrderRow; canManage: boolean; online: boolean; isPending: boolean; onComplete: (resolutionNote: string) => void }) {
  const [resolutionNote, setResolutionNote] = useState('');
  return (
    <article className="p-3.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><div className="truncate text-[13px]">{order.title}</div><div className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{order.reference} · {order.branchName}{order.equipmentName ? ` · ${order.equipmentName}` : ''}</div></div>
        <Chip tone={SEVERITY_TONE[order.severity] ?? 'neutral'}>{order.severity}</Chip>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5"><Chip tone={STATE_TONE[order.state] ?? 'neutral'}>{order.state.replace(/_/g, ' ')}</Chip>{order.overdue ? <Chip tone="bad">overdue</Chip> : null}{order.needsReassignment ? <Chip tone="warn">needs reassignment</Chip> : null}{order.duplicateOfId ? <Chip tone="warn">possible duplicate</Chip> : null}{order.restricted ? <Chip tone="bad">restricted details</Chip> : null}</div>
      <div className="mt-2 text-[11px] text-foam-45">Reported by {order.reportedByName} · {order.assigneeName ? `assigned to ${order.assigneeName}` : 'unassigned'} · opened {dateLabel(order.openedAt)}</div>
      {order.description ? <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-foam-65">{order.description}</p> : null}
      {canManage && order.state !== 'done' && order.state !== 'cancelled' ? <div className="mt-3 flex items-end gap-2"><Field label="Resolution note" value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} placeholder="What was fixed and verified?" className="min-w-0 flex-1" /><Button variant="outline" onClick={() => onComplete(resolutionNote.trim())} disabled={!online || isPending || !resolutionNote.trim()}>{isPending ? 'Closing…' : 'Close work order'}</Button></div> : null}
    </article>
  );
}

function TaskCard({ task, canManage, online, isPending, onComplete }: { task: FacilityTaskRow; canManage: boolean; online: boolean; isPending: boolean; onComplete: () => void }) {
  return (
    <article className="bg-hull p-3.5">
      <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="text-[13px]">{task.title}</div><div className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{task.branchName} · {task.cadence}</div></div><Chip tone={STATE_TONE[task.state] ?? 'neutral'}>{task.state}</Chip></div>
      <div className="mt-2 text-[11px] text-foam-45">Due {dateLabel(task.nextDueAt)} · {task.assigneeName ? task.assigneeName : 'unassigned'}</div>
      {task.branchState === 'temporarily_closed' ? <Chip tone="neutral" className="mt-2">branch temporarily closed</Chip> : null}
      {task.overdue ? <Chip tone="warn" className="mt-2">overdue</Chip> : null}
      <ul className="mt-2 space-y-1 text-[11px] text-foam-65">{task.checklist.slice(0, 4).map((item) => <li key={item}><span aria-hidden="true" className="mr-1 text-sonar">□</span>{item}</li>)}{task.checklist.length > 4 ? <li className="text-foam-35">+{task.checklist.length - 4} more checks</li> : null}</ul>
      {canManage && task.state !== 'done' ? <div className="mt-3 flex justify-end"><Button variant="outline" onClick={onComplete} disabled={!online || isPending}>{isPending ? 'Saving…' : 'Complete task'}</Button></div> : null}
    </article>
  );
}

function CreateEquipmentDialog({ branches, activeBranchId, online, onClose }: { branches: Array<{ id: string; name: string }>; activeBranchId: string | null; online: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const [branchId, setBranchId] = useState(activeBranchId ?? branches[0]?.id ?? '');
  const [area, setArea] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [vendor, setVendor] = useState('');
  const [warrantyUntil, setWarrantyUntil] = useState('');
  const [serviceIntervalDays, setServiceIntervalDays] = useState('90');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api('/admin/facility/equipment', { method: 'POST', idempotencyKey: idempotencyKey('facility-equipment', assetTag.trim()), body: { name: name.trim(), assetTag: assetTag.trim(), branchId, area: area.trim(), model: model.trim(), serial: serial.trim(), vendor: vendor.trim(), warrantyUntil: warrantyUntil || null, serviceIntervalDays: Number(serviceIntervalDays), linkedExerciseId: null, status: 'available' } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['facility'] }); onClose(); },
  });
  const error = create.error instanceof ApiError ? create.error.message : create.isError ? 'That equipment could not be added.' : fieldError;
  return <Dialog title="Add equipment" onClose={onClose}><div className="flex flex-col gap-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Cable crossover" autoFocus /><Field label="Asset / QR identifier" value={assetTag} onChange={(event) => setAssetTag(event.target.value)} placeholder="KOR-021" /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><SelectField label="Branch" value={branchId} onChange={setBranchId} options={branches.map((branch) => [branch.id, branch.name] as [string, string])} /><Field label="Area" value={area} onChange={(event) => setArea(event.target.value)} placeholder="Strength floor" /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Field label="Model" value={model} onChange={(event) => setModel(event.target.value)} /><Field label="Serial" value={serial} onChange={(event) => setSerial(event.target.value)} /><Field label="Vendor" value={vendor} onChange={(event) => setVendor(event.target.value)} /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Warranty until" type="date" value={warrantyUntil} onChange={(event) => setWarrantyUntil(event.target.value)} /><Field label="Service interval (days)" type="number" min={1} max={3650} value={serviceIntervalDays} onChange={(event) => setServiceIntervalDays(event.target.value)} /></div>{error ? <Panel tone="bad"><p className="px-3 py-2.5 text-[12px]">{error}</p></Panel> : null}</div><DialogActions onClose={onClose} isPending={create.isPending} disabled={!online || !name.trim() || !assetTag.trim() || !branchId || !area.trim()} label="Add equipment" onConfirm={() => { setFieldError(null); if (!name.trim() || !assetTag.trim() || !area.trim()) { setFieldError('Name, asset identifier and area are required.'); return; } create.mutate(); }} /></Dialog>;
}

function CreateIssueDialog({ equipment, branches, activeBranchId, online, onClose }: { equipment: EquipmentRow[]; branches: Array<{ id: string; name: string }>; activeBranchId: string | null; online: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [equipmentId, setEquipmentId] = useState('');
  const [branchId, setBranchId] = useState(activeBranchId ?? branches[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [cost, setCost] = useState('');
  const selectedEquipment = equipment.find((item) => item.id === equipmentId);
  const selectedBranchId = selectedEquipment?.branchId ?? branchId;
  const assignees = useQuery({ queryKey: ['facility', 'assignees', selectedBranchId], queryFn: () => api<{ items: Assignee[] }>(`/admin/facility/assignees?branchId=${encodeURIComponent(selectedBranchId)}`), enabled: Boolean(selectedBranchId) });
  const create = useMutation({
    mutationFn: () => api<{ workOrder: { duplicateOfId: string | null } }>('/admin/facility/work-orders', { method: 'POST', idempotencyKey: idempotencyKey('facility-work-order', title.trim()), body: { branchId: selectedBranchId, equipmentId: equipmentId || null, title: title.trim(), description: description.trim(), severity, reportedByKind: 'staff', assigneeId: assigneeId || null, costMinor: cost.trim() ? Math.round(Number(cost) * 100) : 0 } }),
    onSuccess: (result) => { void queryClient.invalidateQueries({ queryKey: ['facility'] }); if (!result.workOrder.duplicateOfId) onClose(); },
  });
  const error = create.error instanceof ApiError ? create.error.message : create.isError ? 'That issue could not be reported.' : null;
  return <Dialog title="Report facility issue" onClose={onClose}><div className="flex flex-col gap-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><SelectField label="Equipment" value={equipmentId} onChange={(value) => { setEquipmentId(value); const item = equipment.find((entry) => entry.id === value); if (item) setBranchId(item.branchId); }} options={[['', 'Facility / no asset'], ...equipment.map((item) => [item.id, `${item.assetTag} · ${item.name}`] as [string, string])]} /><SelectField label="Branch" value={branchId} onChange={setBranchId} options={branches.map((branch) => [branch.id, branch.name] as [string, string])} /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Issue" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Bearing noise under load" autoFocus /><SelectField label="Severity" value={severity} onChange={setSeverity} options={[['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['safety', 'Safety']]} /></div><label className="flex flex-col gap-1"><span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">Description</span><textarea className="sf-field min-h-24 !py-2 text-[13px]" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What happened and where?" /></label><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><SelectField label="Assign to" value={assigneeId} onChange={setAssigneeId} options={[['', 'Unassigned'], ...(assignees.data?.items ?? []).map((person) => [person.id, person.name] as [string, string])]} /><Field label="Cost (₹)" type="number" min={0} value={cost} onChange={(event) => setCost(event.target.value)} placeholder="0" /></div>{create.isSuccess && create.data.workOrder.duplicateOfId ? <Panel tone="warn"><p className="px-3 py-2.5 text-[12px]">This report matches an open issue. It remains a separate record and is marked as a possible duplicate for review.</p></Panel> : null}{error ? <Panel tone="bad"><p className="px-3 py-2.5 text-[12px]">{error}</p></Panel> : null}</div><DialogActions onClose={onClose} isPending={create.isPending} disabled={!online || !title.trim() || !selectedBranchId} label="Report issue" onConfirm={() => create.mutate()} /></Dialog>;
}

function CreateTaskDialog({ branches, activeBranchId, online, onClose }: { branches: Array<{ id: string; name: string }>; activeBranchId: string | null; online: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [branchId, setBranchId] = useState(activeBranchId ?? branches[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [cadence, setCadence] = useState('daily');
  const [nextDueAt, setNextDueAt] = useState(toLocalInput(Date.now() + DAY));
  const [checklist, setChecklist] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const assignees = useQuery({ queryKey: ['facility', 'assignees', branchId], queryFn: () => api<{ items: Assignee[] }>(`/admin/facility/assignees?branchId=${encodeURIComponent(branchId)}`), enabled: Boolean(branchId) });
  const create = useMutation({
    mutationFn: () => api('/admin/facility/tasks', { method: 'POST', idempotencyKey: idempotencyKey('facility-task', title.trim()), body: { branchId, title: title.trim(), cadence, nextDueAt: new Date(nextDueAt).toISOString(), assigneeId: assigneeId || null, checklist: checklist.split(',').map((item) => item.trim()).filter(Boolean) } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['facility'] }); onClose(); },
  });
  const error = create.error instanceof ApiError ? create.error.message : create.isError ? 'That facility task could not be created.' : null;
  return <Dialog title="New facility task" onClose={onClose}><div className="flex flex-col gap-3"><Field label="Task" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Opening checks" autoFocus /><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><SelectField label="Branch" value={branchId} onChange={setBranchId} options={branches.map((branch) => [branch.id, branch.name] as [string, string])} /><SelectField label="Cadence" value={cadence} onChange={setCadence} options={[['once', 'Once'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly']]} /><Field label="Next due" type="datetime-local" value={nextDueAt} onChange={(event) => setNextDueAt(event.target.value)} /></div><SelectField label="Assign to" value={assigneeId} onChange={setAssigneeId} options={[['', 'Unassigned'], ...(assignees.data?.items ?? []).map((person) => [person.id, person.name] as [string, string])]} /><Field label="Checklist" value={checklist} onChange={(event) => setChecklist(event.target.value)} hint="Comma-separated checks" placeholder="Floor walk, sanitiser stations" />{error ? <Panel tone="bad"><p className="px-3 py-2.5 text-[12px]">{error}</p></Panel> : null}</div><DialogActions onClose={onClose} isPending={create.isPending} disabled={!online || !title.trim() || !branchId || !checklist.trim()} label="Create task" onConfirm={() => create.mutate()} /></Dialog>;
}

/**
 * Lifting a safety hold is deliberate, not a side effect of closing a ticket.
 * The note is required because it is what the audit entry records.
 */
function ReturnToServiceDialog({ equipment, online, onClose }: { equipment: EquipmentRow; online: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const returnToService = useMutation({
    mutationFn: () => api(`/admin/facility/equipment/${equipment.id}/return-to-service`, { method: 'POST', body: { note: note.trim() } }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['facility'] }); onClose(); },
  });
  const error = returnToService.error instanceof ApiError ? returnToService.error.message : returnToService.isError ? 'That asset could not be returned to service.' : null;
  return (
    <Dialog title="Return to service" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-[12px] leading-relaxed text-foam-65">
          {equipment.name} · {equipment.assetTag} is out of service. Returning it puts it back in front of members, so record who checked it and what they verified.
        </p>
        <Field label="Safety check" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Who inspected it and what they confirmed" autoFocus />
        {error ? <Panel tone="bad"><p className="px-3 py-2.5 text-[12px]">{error}</p></Panel> : null}
      </div>
      <DialogActions onClose={onClose} isPending={returnToService.isPending} disabled={!online || !note.trim()} label="Return to service" onConfirm={() => returnToService.mutate()} />
    </Dialog>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-6" role="presentation"><div className="max-h-[88vh] w-[min(640px,100%)] overflow-auto border border-line-strong bg-overlay p-4" role="dialog" aria-modal="true" aria-label={title}><div className="flex items-center gap-2"><Display size="sm" as="h2">{title}</Display><span className="flex-1" /><Button variant="ghost" onClick={onClose} aria-label="Close dialog">Close</Button></div><div className="mt-4">{children}</div></div></div>;
}

function DialogActions({ onClose, isPending, disabled, label, onConfirm }: { onClose: () => void; isPending: boolean; disabled: boolean; label: string; onConfirm: () => void }) {
  return <div className="mt-5 flex justify-end gap-2 border-t border-line pt-3"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="cta" disabled={disabled || isPending} onClick={onConfirm}>{isPending ? 'Saving…' : label}</Button></div>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <div className="flex flex-col gap-1"><Label>{label}</Label><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="sf-field !min-h-9 !py-2 !text-[13px]">{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></div>;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatMinor(value: number): string {
  return `₹${Math.round(value / 100).toLocaleString('en-IN')}`;
}

function toLocalInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}
