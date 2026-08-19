import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useOnline } from '../lib/realtime';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Field, Label, Panel, PermissionState, Seam, SelectField as ConsoleSelectField, Skeleton, Toolbar, type Tone } from '../ui/console';
import { Modal } from '../ui/overlay';

interface Program { id: string; name: string; version: number; goal: string; daysPerWeek: number; weeks: number; authorName: string; state: 'draft' | 'published' | 'archived'; description: string; }
interface Day { id: string; week: number; dayIndex: number; label: string; focus: string; isRest: boolean; estimatedMin: number; items: Item[]; }
interface Item { id: string; orderIndex: number; exerciseId: string; exerciseName: string; sets: PrescribedSet[]; targetLabel: string; supersetGroup: string | null; tempo: string | null; notes: string | null; rationale: string | null; trainerLocked: boolean; allowedSubstitutionIds: string[]; }
interface PrescribedSet { setIndex: number; targetWeightKg: number | null; repLow: number; repHigh: number; targetRpe: number | null; restSec: number; isWarmup: boolean; }
interface DetailPayload { program: Program; days: Day[]; }
interface ExercisePayload { items: Array<{ id: string; name: string; equipment: string; archived: boolean }>; }

const STATE_TONE: Record<string, Tone> = { draft: 'warn', published: 'good', archived: 'neutral' };
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_SET: PrescribedSet = { setIndex: 1, targetWeightKg: null, repLow: 8, repHigh: 10, targetRpe: 8, restSec: 90, isWarmup: false };

export default function TrainingBuilderScreen() {
  const { programId } = useParams({ from: '/console/training/$programId' });
  const canView = usePermission('training.view');
  const canManage = usePermission('training.program.manage');
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'day' | 'item' | 'archive'; id: string } | null>(null);
  const [showDayForm, setShowDayForm] = useState(false);
  const [itemDayId, setItemDayId] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ['training', 'program', programId], queryFn: () => api<DetailPayload>(`/admin/training/programs/${programId}`), enabled: canView });
  const exercises = useQuery({ queryKey: ['training', 'exercises', 'builder'], queryFn: () => api<ExercisePayload>('/admin/training/exercises'), enabled: canView });

  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ['training', 'program', programId] }); void queryClient.invalidateQueries({ queryKey: ['training', 'programs'] }); };
  const mutate = (fn: () => Promise<unknown>, success?: () => void): void => { setActionError(null); void fn().then(() => { refresh(); success?.(); }).catch((error: unknown) => setActionError(error instanceof ApiError ? error.message : 'That change did not go through.')); };

  const updateMeta = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/admin/training/programs/${programId}`, { method: 'PATCH', body }) });
  const publish = useMutation({ mutationFn: () => api(`/admin/training/programs/${programId}/publish`, { method: 'POST' }) });
  const archive = useMutation({ mutationFn: () => api(`/admin/training/programs/${programId}/archive`, { method: 'POST' }) });
  const version = useMutation({ mutationFn: () => api<{ program: { id: string } }>(`/admin/training/programs/${programId}/version`, { method: 'POST' }) });
  const deleteDay = useMutation({ mutationFn: (id: string) => api(`/admin/training/days/${id}`, { method: 'DELETE' }) });
  const deleteItem = useMutation({ mutationFn: (id: string) => api(`/admin/training/items/${id}`, { method: 'DELETE' }) });

  if (!canView) return <Page title="Program builder"><PermissionState what="Training programs" /></Page>;
  if (detail.isLoading || exercises.isLoading) return <BuilderSkeleton />;
  if (detail.error || exercises.error || !detail.data || !exercises.data) {
    const error = detail.error ?? exercises.error;
    const body = !online || error instanceof OfflineError ? 'This machine is offline. Reconnect to load the program.' : error instanceof ApiError ? error.message : 'The API did not answer. Nothing has changed.';
    return <Page title="Program builder"><ErrorState title="Could not load this program" body={body} onRetry={() => { void detail.refetch(); void exercises.refetch(); }} /></Page>;
  }

  const { program, days } = detail.data;
  const exerciseItems = exercises.data.items.filter((exercise) => !exercise.archived);
  const itemCount = days.reduce((total, day) => total + day.items.length, 0);
  const canPublish = program.state === 'draft' && days.some((day) => !day.isRest && day.items.length > 0);

  const doPublish = (): void => mutate(() => publish.mutateAsync(), undefined);
  const doArchive = (): void => mutate(() => archive.mutateAsync(), () => setConfirm(null));
  const doVersion = (): void => { setActionError(null); void version.mutateAsync().then((result) => void navigate({ to: '/training/$programId', params: { programId: result.program.id } })).catch((error: unknown) => setActionError(error instanceof ApiError ? error.message : 'A new version could not be created.')); };

  return (
    <Page title={program.name} kicker={`Program builder · v${program.version}`} actions={<div className="flex items-center gap-2"><Chip tone={STATE_TONE[program.state] ?? 'neutral'}>{program.state}</Chip>{program.state === 'draft' && canManage ? <Button variant="cta" disabled={!online || !canPublish || publish.isPending} onClick={doPublish}>{publish.isPending ? 'Publishing…' : 'Publish version'}</Button> : null}{program.state !== 'draft' && canManage ? <Button variant="outline" disabled={!online || version.isPending} onClick={doVersion}>{version.isPending ? 'Copying…' : 'Create new version'}</Button> : null}</div>}>
      {!online ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">You are offline. Published content remains visible, but changes are disabled.</p></Panel> : null}
      {actionError ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">{actionError}</p></Panel> : null}
      <Seam className="border-b border-line">
        <div className="min-w-[170px] flex-1 px-3.5 py-3"><Label>Goal</Label><div className="mt-1.5 text-[13px]">{program.goal.replace(/_/g, ' ')}</div></div>
        <div className="min-w-[170px] flex-1 px-3.5 py-3"><Label>Cadence</Label><div className="mt-1.5 text-[13px]">{program.daysPerWeek} days/week · {program.weeks} weeks</div></div>
        <div className="min-w-[170px] flex-1 px-3.5 py-3"><Label>Content</Label><div className="mt-1.5 text-[13px]">{days.length} days · {itemCount} exercises</div></div>
      </Seam>
      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.5fr)]">
        <MetaPanel program={program} editable={canManage && online && program.state === 'draft'} isPending={updateMeta.isPending} onSave={(body) => mutate(() => updateMeta.mutateAsync(body))} />
        <Panel title="Program outline" action={canManage && online && program.state === 'draft' ? <Button variant="ghost" onClick={() => setShowDayForm(true)}>Add day</Button> : null}>
          {!canPublish && program.state === 'draft' ? <p className="border-b border-line bg-wash-flare px-3.5 py-2.5 text-[12px]">Publishing needs at least one non-rest day with an active exercise.</p> : null}
          {days.length === 0 ? <EmptyState title="No days yet" body="Add a week and day, then place exercises inside it." action={canManage && online && program.state === 'draft' ? <Button variant="cta" onClick={() => setShowDayForm(true)}>Add first day</Button> : undefined} /> : <div className="divide-y divide-line">{days.map((day) => <DayPanel key={day.id} day={day} editable={canManage && online && program.state === 'draft'} exercises={exerciseItems} itemDayId={itemDayId} setItemDayId={setItemDayId} onDelete={() => setConfirm({ kind: 'day', id: day.id })} onDeleteItem={(id) => setConfirm({ kind: 'item', id })} onAddItem={(body) => mutate(() => api(`/admin/training/days/${day.id}/items`, { method: 'POST', idempotencyKey: idempotencyKey('program-item', day.id, String(body.exerciseId ?? 'exercise')), body }), () => setItemDayId(null))} onMoveItem={(item, delta) => mutate(() => api(`/admin/training/items/${item.id}`, { method: 'PATCH', body: { orderIndex: Math.max(0, item.orderIndex + delta) } }))} />)}</div>}
        </Panel>
      </div>
      {program.state === 'published' && canManage && online ? <Panel title="Version lifecycle" action={<Button variant="danger" onClick={() => setConfirm({ kind: 'archive', id: program.id })}>Archive version</Button>}><p className="px-3.5 py-3 text-[12px] leading-relaxed text-foam-65">Publishing freezes this version so assigned members keep the exact prescription they received. Create a new version when the plan needs edits.</p></Panel> : null}
      {showDayForm ? <DayForm program={program} isPending={false} onClose={() => setShowDayForm(false)} onSave={(body) => mutate(() => api(`/admin/training/programs/${program.id}/days`, { method: 'POST', idempotencyKey: idempotencyKey('program-day', program.id, String(body.week), String(body.dayIndex)), body }), () => setShowDayForm(false))} /> : null}
      {confirm ? <ConfirmDialog kind={confirm.kind} isPending={deleteDay.isPending || deleteItem.isPending || archive.isPending} onClose={() => setConfirm(null)} onConfirm={() => { if (confirm.kind === 'day') mutate(() => deleteDay.mutateAsync(confirm.id), () => setConfirm(null)); else if (confirm.kind === 'item') mutate(() => deleteItem.mutateAsync(confirm.id), () => setConfirm(null)); else doArchive(); }} /> : null}
    </Page>
  );
}

function MetaPanel({ program, editable, isPending, onSave }: { program: Program; editable: boolean; isPending: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(program.name);
  const [goal, setGoal] = useState(program.goal);
  const [description, setDescription] = useState(program.description);
  return <Panel title="Program metadata"><div className="flex flex-col gap-3 p-3.5">{editable ? <><Field label="Name" value={name} onChange={(event) => setName(event.target.value)} /><SelectField label="Goal" value={goal} onChange={setGoal} options={['general', 'hypertrophy', 'strength', 'fat_loss', 'endurance', 'rehab'].map((value) => [value, value.replace(/_/g, ' ')] as [string, string])} /><div className="flex flex-col gap-1"><Label>Description</Label><textarea aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} className="sf-field min-h-24 text-[13px]" /></div><Button variant="outline" disabled={isPending || !name.trim()} onClick={() => onSave({ name: name.trim(), goal, description })}>{isPending ? 'Saving…' : 'Save metadata'}</Button></> : <><Info label="Name" value={program.name} /><Info label="Goal" value={program.goal.replace(/_/g, ' ')} /><Info label="Description" value={program.description || 'No description recorded.'} /><Info label="Author" value={program.authorName} /></>}</div></Panel>;
}

function DayPanel({ day, editable, exercises, itemDayId, setItemDayId, onDelete, onDeleteItem, onAddItem, onMoveItem }: { day: Day; editable: boolean; exercises: ExercisePayload['items']; itemDayId: string | null; setItemDayId: (id: string | null) => void; onDelete: () => void; onDeleteItem: (id: string) => void; onAddItem: (body: Record<string, unknown>) => void; onMoveItem: (item: Item, delta: number) => void }) {
  return <section className="bg-hull"><header className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2.5"><div className="min-w-0 flex-1"><div className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-sonar">Week {day.week} · {DAY_NAMES[day.dayIndex] ?? `Day ${day.dayIndex + 1}`}</div><div className="mt-1 text-[14px]">{day.label} <span className="text-foam-35">· {day.focus}</span></div></div><Chip tone={day.isRest ? 'neutral' : 'accent'}>{day.isRest ? 'rest' : `${day.items.length} exercises`}</Chip>{editable ? <><Button variant="ghost" onClick={() => setItemDayId(itemDayId === day.id ? null : day.id)} disabled={day.isRest}>{itemDayId === day.id ? 'Close exercise form' : 'Add exercise'}</Button><Button variant="danger" onClick={onDelete}>Remove day</Button></> : null}</header>{day.items.length === 0 ? <p className="px-3.5 py-3 text-[12px] text-foam-45">{day.isRest ? 'Recovery day.' : 'No exercises yet.'}</p> : <div className="divide-y divide-line">{day.items.slice().sort((a, b) => a.orderIndex - b.orderIndex).map((item, index) => <div key={item.id} className="px-3.5 py-3"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="text-[13px]">{item.exerciseName}</div><div className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{item.targetLabel}{item.tempo ? ` · tempo ${item.tempo}` : ''}{item.trainerLocked ? ' · locked' : ''}</div><div className="mt-1 text-[11px] text-foam-50">{item.sets.map((set) => `${set.isWarmup ? 'W' : 'S'}${set.setIndex}: ${set.repLow}-${set.repHigh}${set.targetWeightKg === null ? '' : ` @ ${set.targetWeightKg}kg`}${set.targetRpe === null ? '' : ` · RPE ${set.targetRpe}`}`).join('  ·  ')}</div></div>{editable ? <div className="flex gap-1"><Button variant="ghost" onClick={() => onMoveItem(item, -1)} disabled={index === 0} aria-label={`Move ${item.exerciseName} up`}>↑</Button><Button variant="ghost" onClick={() => onMoveItem(item, 1)} disabled={index === day.items.length - 1} aria-label={`Move ${item.exerciseName} down`}>↓</Button><Button variant="danger" onClick={() => onDeleteItem(item.id)} aria-label={`Remove ${item.exerciseName}`}>Remove</Button></div> : null}</div>{item.notes || item.rationale ? <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-foam-45">{item.notes ?? item.rationale}</p> : null}</div>)}</div>}{itemDayId === day.id && editable ? <ItemForm exercises={exercises} onSave={onAddItem} /> : null}</section>;
}

function DayForm({ program, isPending, onClose, onSave }: { program: Program; isPending: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) { const [week, setWeek] = useState('1'); const [dayIndex, setDayIndex] = useState('0'); const [label, setLabel] = useState('Training day'); const [focus, setFocus] = useState('general'); const [isRest, setIsRest] = useState(false); return <Dialog title="Add program day" onClose={onClose}><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Week" type="number" min={1} max={program.weeks} value={week} onChange={(event) => setWeek(event.target.value)} /><SelectField label="Day" value={dayIndex} onChange={setDayIndex} options={DAY_NAMES.map((value, index) => [String(index), value] as [string, string])} /><Field label="Label" value={label} onChange={(event) => setLabel(event.target.value)} /><Field label="Focus" value={focus} onChange={(event) => setFocus(event.target.value)} /><label className="flex min-h-11 items-center gap-2 text-[12px]"><input type="checkbox" checked={isRest} onChange={(event) => setIsRest(event.target.checked)} /> Recovery day</label></div><DialogActions onClose={onClose} isPending={isPending} disabled={!label.trim() || !focus.trim()} label="Add day" onConfirm={() => onSave({ week: Number(week), dayIndex: Number(dayIndex), label: label.trim(), focus: focus.trim(), isRest, estimatedMin: isRest ? 0 : 45 })} /></Dialog>; }

function ItemForm({ exercises, onSave }: { exercises: ExercisePayload['items']; onSave: (body: Record<string, unknown>) => void }) { const [exerciseId, setExerciseId] = useState(exercises[0]?.id ?? ''); const [targetLabel, setTargetLabel] = useState('3 × 8-10'); const [sets, setSets] = useState<PrescribedSet[]>([DEFAULT_SET]); const [tempo, setTempo] = useState(''); const [notes, setNotes] = useState(''); const addSet = (): void => setSets((current) => [...current, { ...DEFAULT_SET, setIndex: current.length + 1 }]); const updateSet = (index: number, patch: Partial<PrescribedSet>): void => setSets((current) => current.map((set, setIndex) => setIndex === index ? { ...set, ...patch } : set)); return <div className="border-t border-line bg-wash-sonar-soft p-3.5"><div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_170px]"><SelectField label="Exercise" value={exerciseId} onChange={setExerciseId} options={exercises.map((exercise) => [exercise.id, `${exercise.name} · ${exercise.equipment}`] as [string, string])} /><Field label="Target label" value={targetLabel} onChange={(event) => setTargetLabel(event.target.value)} /></div><div className="mt-3 divide-y divide-line border-y border-line">{sets.map((set, index) => <div key={set.setIndex} className="grid grid-cols-2 gap-2 py-2 sm:grid-cols-5"><Field label={`Set ${set.setIndex} reps low`} type="number" min={0} value={set.repLow} onChange={(event) => updateSet(index, { repLow: Number(event.target.value) })} /><Field label="Reps high" type="number" min={0} value={set.repHigh} onChange={(event) => updateSet(index, { repHigh: Number(event.target.value) })} /><Field label="Load kg" type="number" min={0} step="0.5" value={set.targetWeightKg ?? ''} onChange={(event) => updateSet(index, { targetWeightKg: event.target.value === '' ? null : Number(event.target.value) })} /><Field label="RPE" type="number" min={1} max={10} value={set.targetRpe ?? ''} onChange={(event) => updateSet(index, { targetRpe: event.target.value === '' ? null : Number(event.target.value) })} /><Field label="Rest sec" type="number" min={0} max={600} value={set.restSec} onChange={(event) => updateSet(index, { restSec: Number(event.target.value) })} /></div>)}</div><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Tempo" value={tempo} onChange={(event) => setTempo(event.target.value)} placeholder="3-1-1-0" /><Field label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Keep two reps in reserve" /></div><Toolbar className="mt-3 -mx-3.5 -mb-3.5 border-t"><Button variant="ghost" onClick={addSet}>Add set</Button><Button variant="cta" disabled={!exerciseId || !targetLabel.trim()} onClick={() => onSave({ exerciseId, sets, targetLabel: targetLabel.trim(), supersetGroup: null, tempo: tempo || null, notes: notes || null, rationale: null, trainerLocked: false, allowedSubstitutionIds: [] })}>Add exercise</Button></Toolbar></div>; }

function ConfirmDialog({ kind, isPending, onClose, onConfirm }: { kind: 'day' | 'item' | 'archive'; isPending: boolean; onClose: () => void; onConfirm: () => void }) { const archive = kind === 'archive'; return <Dialog title={archive ? 'Archive published version?' : kind === 'day' ? 'Remove program day?' : 'Remove exercise from day?'} onClose={onClose}><p className="text-[13px] leading-relaxed text-foam-65">{archive ? 'Assigned members keep their frozen version. New assignments will no longer use this published version.' : kind === 'day' ? 'The day and all exercises inside it will be removed from this draft.' : 'This removes the prescription from the draft. Workout history is not changed.'}</p><DialogActions onClose={onClose} isPending={isPending} label={archive ? 'Archive version' : 'Remove'} onConfirm={onConfirm} danger /></Dialog>; }
/* The shared modal, not a local copy of one. This wrapper declared
   `aria-modal="true"` and then let focus tab straight out behind it. */
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="p-4">{children}</div>
    </Modal>
  );
}
function DialogActions({ onClose, isPending, disabled, label, onConfirm, danger = false }: { onClose: () => void; isPending: boolean; disabled?: boolean; label: string; onConfirm: () => void; danger?: boolean }) { return <div className="mt-5 flex justify-end gap-2 border-t border-line pt-3"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'cta'} disabled={isPending || disabled} onClick={onConfirm}>{isPending ? 'Saving…' : label}</Button></div>; }
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
function Info({ label, value }: { label: string; value: string }) { return <div><Label>{label}</Label><p className="mt-1 text-[13px] leading-relaxed text-foam-80">{value}</p></div>; }
function BuilderSkeleton() { return <Page title="Program builder" kicker="Loading"><div className="grid grid-cols-1 gap-px bg-line p-4 md:grid-cols-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-56" />)}</div></Page>; }
