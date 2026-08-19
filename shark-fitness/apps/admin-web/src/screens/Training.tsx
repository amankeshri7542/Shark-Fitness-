import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Field, Label, Metric, Panel, PermissionState, Seam, SelectField as ConsoleSelectField, Skeleton, Toolbar, type Tone } from '../ui/console';
import { Modal } from '../ui/overlay';

interface ExerciseRow { id: string; slug: string; name: string; equipment: string; primaryMuscles: string[]; difficulty: string; archived: boolean; defaultRestSec: number; }
interface ProgramRow { id: string; name: string; version: number; goal: string; daysPerWeek: number; weeks: number; authorName: string; state: 'draft' | 'published' | 'archived'; description: string; updatedAt: number; }
interface ExercisePayload { total: number; items: ExerciseRow[]; }
interface ProgramPayload { total: number; items: ProgramRow[]; }

const STATE_TONE: Record<string, Tone> = { draft: 'warn', published: 'good', archived: 'neutral' };
const EQUIPMENT = ['bodyweight', 'barbell', 'dumbbell', 'cable', 'machine', 'kettlebell', 'band', 'other'];

export default function TrainingScreen() {
  const canView = usePermission('training.view');
  const canManage = usePermission('training.program.manage');
  const online = useOnline();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [exerciseQuery, setExerciseQuery] = useState('');
  const [equipment, setEquipment] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [programState, setProgramState] = useState('');
  const [showExerciseForm, setShowExerciseForm] = useState(false);
  const [showProgramForm, setShowProgramForm] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);

  const exercises = useQuery({
    queryKey: ['training', 'exercises', exerciseQuery, equipment, showArchived],
    queryFn: () => api<ExercisePayload>(`/admin/training/exercises?${new URLSearchParams({ ...(exerciseQuery ? { q: exerciseQuery } : {}), ...(equipment ? { equipment } : {}), archived: String(showArchived) })}`),
    enabled: canView,
  });
  const programs = useQuery({
    queryKey: ['training', 'programs', programState],
    queryFn: () => api<ProgramPayload>(`/admin/training/programs${programState ? `?state=${programState}` : ''}`),
    enabled: canView,
  });

  const createExercise = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/admin/training/exercises', { method: 'POST', idempotencyKey: idempotencyKey('exercise-create', String(body.slug ?? 'exercise')), body }),
    onSuccess: () => { setShowExerciseForm(false); void queryClient.invalidateQueries({ queryKey: ['training', 'exercises'] }); },
  });
  const archiveExercise = useMutation({
    mutationFn: (id: string) => api(`/admin/training/exercises/${id}/archive`, { method: 'POST' }),
    onSuccess: () => { setArchiveId(null); void queryClient.invalidateQueries({ queryKey: ['training', 'exercises'] }); },
  });
  const createProgram = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ program: { id: string } }>('/admin/training/programs', { method: 'POST', idempotencyKey: idempotencyKey('program-create', String(body.name ?? 'program')), body }),
    onSuccess: ({ program }) => { setShowProgramForm(false); void navigate({ to: '/training/$programId', params: { programId: program.id } }); },
  });

  if (!canView) return <Page title="Training"><PermissionState what="Training programs and the exercise library" /></Page>;
  const loadError = exercises.error ?? programs.error;
  if ((exercises.isLoading && !exercises.data) || (programs.isLoading && !programs.data)) return <TrainingSkeleton />;
  if (loadError || !exercises.data || !programs.data) {
    const body = !online || loadError instanceof OfflineError ? 'This machine is offline. Reconnect to read the current catalogue.' : loadError instanceof ApiError ? loadError.message : 'The API did not answer. Nothing has changed.';
    return <Page title="Training"><ErrorState title="Could not load training" body={body} onRetry={() => { void exercises.refetch(); void programs.refetch(); }} /></Page>;
  }

  return (
    <Page title="Training" kicker="Programs and exercise library" actions={canManage ? <Button variant="cta" onClick={() => setShowProgramForm(true)} disabled={!online}>New program</Button> : null}>
      {!online ? <Panel tone="bad" className="border-b border-line"><p className="px-3.5 py-2.5 text-[12px]">You are offline. Training content is read-only until the connection returns.</p></Panel> : null}
      <Seam className="border-b border-line">
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Programs</Label><div className="mt-1.5"><Metric value={programs.data.total} size="md" /></div></div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Visible exercises</Label><div className="mt-1.5"><Metric value={exercises.data.total} size="md" /></div></div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3"><Label>Published</Label><div className="mt-1.5"><Metric value={programs.data.items.filter((program) => program.state === 'published').length} size="md" tone="good" /></div></div>
      </Seam>
      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
        <Panel title="Exercise library" action={canManage ? <Button variant="ghost" onClick={() => setShowExerciseForm(true)} disabled={!online}>Add exercise</Button> : null}>
          <Toolbar className="border-b-0"><Field label="Search" placeholder="Exercise name" value={exerciseQuery} onChange={(event) => setExerciseQuery(event.target.value)} /><SelectField label="Equipment" value={equipment} onChange={setEquipment} options={[['', 'All equipment'], ...EQUIPMENT.map((value) => [value, value] as [string, string])]} /><Button variant={showArchived ? 'cta' : 'outline'} onClick={() => setShowArchived((value) => !value)} aria-pressed={showArchived}>{showArchived ? 'Showing archived' : 'Hide archived'}</Button></Toolbar>
          {exercises.data.items.length === 0 ? <EmptyState title="No exercises in this view" body={showArchived ? 'No archived exercise matches the current filters.' : 'Add a tenant exercise or clear the filters.'} action={canManage ? <Button variant="cta" onClick={() => setShowExerciseForm(true)}>Add exercise</Button> : undefined} /> : <div className="divide-y divide-line">{exercises.data.items.map((exercise) => <div key={exercise.id} className="flex items-center gap-3 px-3.5 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-[13px]">{exercise.name}</div><div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">{exercise.equipment} · {exercise.primaryMuscles.join(', ')}</div></div><Chip tone={exercise.archived ? 'neutral' : 'good'}>{exercise.archived ? 'archived' : exercise.difficulty}</Chip>{canManage && !exercise.archived ? <Button variant="danger" onClick={() => setArchiveId(exercise.id)}>Archive</Button> : null}</div>)}</div>}
        </Panel>
        <Panel title="Program templates" action={<SelectField label="State" value={programState} onChange={setProgramState} options={[['', 'Latest versions'], ['draft', 'Draft'], ['published', 'Published'], ['archived', 'Archived']]} />}>
          {programs.data.items.length === 0 ? <EmptyState title="No program templates" body="Create a draft to start building a plan for your members." action={canManage ? <Button variant="cta" onClick={() => setShowProgramForm(true)}>New program</Button> : undefined} /> : <div className="divide-y divide-line">{programs.data.items.map((program) => <Link key={program.id} to="/training/$programId" params={{ programId: program.id }} className="flex min-h-14 items-center gap-3 px-3.5 py-2.5 hover:bg-wash-sonar"><div className="min-w-0 flex-1"><div className="truncate text-[13px]">{program.name}</div><div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">v{program.version} · {program.goal.replace(/_/g, ' ')} · {program.daysPerWeek} days/week · {program.weeks} weeks</div></div><Chip tone={STATE_TONE[program.state] ?? 'neutral'}>{program.state}</Chip></Link>)}</div>}
        </Panel>
      </div>
      {showExerciseForm ? <ExerciseForm isPending={createExercise.isPending} error={createExercise.error} onClose={() => setShowExerciseForm(false)} onSave={(body) => createExercise.mutate(body)} /> : null}
      {showProgramForm ? <ProgramForm isPending={createProgram.isPending} error={createProgram.error} onClose={() => setShowProgramForm(false)} onSave={(body) => createProgram.mutate(body)} /> : null}
      {archiveId ? <ConfirmDialog title="Archive exercise?" body="Archived exercises disappear from the default catalogue but remain resolvable in existing programs and workout history." isPending={archiveExercise.isPending} onClose={() => setArchiveId(null)} onConfirm={() => archiveExercise.mutate(archiveId)} /> : null}
    </Page>
  );
}

function ExerciseForm({ isPending, error, onClose, onSave }: { isPending: boolean; error: unknown; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [equipment, setEquipment] = useState('bodyweight');
  const [muscle, setMuscle] = useState('core');
  return <Dialog title="Add exercise" onClose={onClose}><div className="flex flex-col gap-3"><Field label="Name" value={name} onChange={(event) => { setName(event.target.value); if (!slug) setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')); }} placeholder="Goblet squat" autoFocus /><Field label="Slug" value={slug} onChange={(event) => setSlug(event.target.value)} hint="Unique within the shared catalogue" /><SelectField label="Equipment" value={equipment} onChange={setEquipment} options={EQUIPMENT.map((value) => [value, value] as [string, string])} /><Field label="Primary muscle" value={muscle} onChange={(event) => setMuscle(event.target.value)} hint="Use a contract muscle group such as full_body, quads or lats" />{error ? <p className="text-[11px] text-chum">{error instanceof ApiError ? error.message : 'That exercise could not be saved.'}</p> : null}</div><DialogActions onClose={onClose} isPending={isPending} disabled={!name.trim() || !slug.trim()} label="Add exercise" onConfirm={() => onSave({ slug: slug.trim(), name: name.trim(), equipment, primaryMuscles: [muscle], secondaryMuscles: [], difficulty: 'intermediate', instructions: [], cues: [], contraindications: [], isUnilateral: false, usesBarbell: equipment === 'barbell', defaultRestSec: 90, loadStepKg: 2.5, mediaUrl: null })} /></Dialog>;
}

function ProgramForm({ isPending, error, onClose, onSave }: { isPending: boolean; error: unknown; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('general');
  const [daysPerWeek, setDaysPerWeek] = useState('3');
  const [weeks, setWeeks] = useState('4');
  return <Dialog title="New program draft" onClose={onClose}><div className="flex flex-col gap-3"><Field label="Program name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Strength foundation" autoFocus /><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><SelectField label="Goal" value={goal} onChange={setGoal} options={['general', 'hypertrophy', 'strength', 'fat_loss', 'endurance', 'rehab'].map((value) => [value, value.replace(/_/g, ' ')] as [string, string])} /><Field label="Days/week" type="number" min={1} max={7} value={daysPerWeek} onChange={(event) => setDaysPerWeek(event.target.value)} /><Field label="Weeks" type="number" min={1} max={52} value={weeks} onChange={(event) => setWeeks(event.target.value)} /></div>{error ? <p className="text-[11px] text-chum">{error instanceof ApiError ? error.message : 'That program could not be created.'}</p> : null}</div><DialogActions onClose={onClose} isPending={isPending} disabled={!name.trim()} label="Create draft" onConfirm={() => onSave({ name: name.trim(), goal, daysPerWeek: Number(daysPerWeek), weeks: Number(weeks), description: '' })} /></Dialog>;
}

function ConfirmDialog({ title, body, isPending, onClose, onConfirm }: { title: string; body: string; isPending: boolean; onClose: () => void; onConfirm: () => void }) { return <Dialog title={title} onClose={onClose}><p className="text-[13px] leading-relaxed text-foam-65">{body}</p><DialogActions onClose={onClose} isPending={isPending} label="Archive" onConfirm={onConfirm} danger /></Dialog>; }
/* The shared modal, not a local copy of one. This wrapper used to be its own
   scrim and panel: it declared `aria-modal="true"` and then let focus tab
   straight out into the page behind it, with no Escape and no restore. */
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
function TrainingSkeleton() { return <Page title="Training" kicker="Loading"><div className="grid grid-cols-1 gap-px bg-line p-4 md:grid-cols-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-64" />)}</div></Page>; }
