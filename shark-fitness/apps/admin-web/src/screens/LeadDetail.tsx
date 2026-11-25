import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, ErrorState, Field, Label, Panel, PermissionState, Seam, SelectField, Skeleton, type Tone } from '../ui/console';
import { SOURCE_LABEL } from './lead-source';
import { ConfirmDialog } from '../ui/overlay';

interface Activity {
  id: string;
  kind: string;
  body: string;
  actorName: string;
  at: string;
  fromStage: string | null;
  toStage: string | null;
}

interface Detail {
  lead: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    source: string;
    stage: string;
    branchName: string;
    ownerName: string | null;
    expectedValueMinor: number;
    nextActionLabel: string | null;
    lossReason: string | null;
    convertedMemberId: string | null;
    slaBreached: boolean;
    tags: string[];
    campaign?: string | null;
    utm?: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null } | null;
    referralCode?: string | null;
    goal?: string | null;
    preferredTime?: string | null;
    interestedPlan?: { id: string; name: string } | null;
    consents?: Array<{ purpose: string; granted: boolean; noticeVersion: string; source: string; capturedAt: string }>;
    trial?: {
      requestedAt: string | null;
      sessionId: string | null;
      sessionLabel: string | null;
      preferredTime: string | null;
      confirmedSessionId: string | null;
      confirmedSessionLabel: string | null;
      confirmedAt: string | null;
    } | null;
  };
  activities: Activity[];
  availableStages: string[];
  duplicate: { id: string; name: string } | null;
  ownerUnavailable: boolean;
  existingMember: { id: string; name: string } | null;
}

const STAGE_TONE: Record<string, Tone> = { won: 'good', lost: 'bad', disqualified: 'bad', nurture: 'warn' };

type LossKind = 'lost' | 'disqualified';

export default function LeadDetailScreen() {
  const { leadId } = useParams({ from: '/console/leads/$leadId' });
  const queryClient = useQueryClient();
  const canView = usePermission('lead.view');
  const canManage = usePermission('lead.manage');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lossSheet, setLossSheet] = useState<LossKind | null>(null);

  const {
    data,
    isLoading,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => api<Detail>(`/admin/leads/${leadId}`),
    enabled: canView,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const moveStage = useMutation({
    mutationFn: ({ to, reason }: { to: string; reason?: string }) =>
      api(`/admin/leads/${leadId}/stage`, { method: 'POST', body: { to, ...(reason ? { reason } : {}) } }),
    onSuccess: () => {
      setLossSheet(null);
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  const logActivity = useMutation({
    mutationFn: () => api(`/admin/leads/${leadId}/activities`, { method: 'POST', body: { kind: 'note', body: note } }),
    onSuccess: () => {
      setNote('');
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  const convert = useMutation({
    mutationFn: () => api<{ memberId: string; message: string }>(`/admin/leads/${leadId}/convert`, { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  // Every hook above this line has to run on each render. Returning early for
  // a viewer without lead.view used to sit above the three useMutation calls,
  // so the hook count changed the moment the permission resolved and React
  // threw "rendered more hooks than during the previous render".
  if (!canView) {
    return (
      <Page title="Lead">
        <PermissionState what="This lead" />
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page title="Lead" kicker="Loading">
        <Skeleton className="m-4 h-64" />
      </Page>
    );
  }

  if (loadError || !data) {
    return (
      <Page title="Lead">
        <ErrorState
          title="Could not load this lead"
          body="The API did not answer. Nothing has changed."
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  const { lead } = data;
  const canConvert = !['won', 'lost', 'disqualified'].includes(lead.stage) && !lead.convertedMemberId;
  const moveableStages = data.availableStages.filter((s) => !['lost', 'disqualified'].includes(s));

  return (
    <Page title={lead.name} kicker={`${lead.branchName} · ${SOURCE_LABEL[lead.source] ?? lead.source.replace(/_/g, ' ')}`}>
      <Seam className="border-b border-line" direction="y">
        <div className="flex flex-wrap items-center gap-2 p-3.5">
          <Chip tone={STAGE_TONE[lead.stage] ?? 'accent'}>{lead.stage.replace(/_/g, ' ')}</Chip>
          {lead.slaBreached ? <Chip tone="bad">follow-up overdue</Chip> : null}
          {data.duplicate ? (
            <Chip tone="warn">
              possible duplicate of{' '}
              <Link to="/leads/$leadId" params={{ leadId: data.duplicate.id }} className="underline">
                {data.duplicate.name}
              </Link>
            </Chip>
          ) : null}
          {data.ownerUnavailable ? <Chip tone="warn">owner unavailable</Chip> : null}
        </div>

        {data.existingMember ? (
          <Panel tone="good">
            <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">
              This lead is already a member.{' '}
              <Link to="/members/$memberId" params={{ memberId: data.existingMember.id }} className="underline">
                Open {data.existingMember.name}&rsquo;s profile
              </Link>
              .
            </p>
          </Panel>
        ) : null}

        <Panel title="Contact">
          <div className="grid grid-cols-2 gap-3 p-3.5 text-[13px]">
            <div>
              <Label>Phone</Label>
              <div className="mt-1">{lead.phone ?? '—'}</div>
            </div>
            <div>
              <Label>Email</Label>
              <div className="mt-1">{lead.email ?? '—'}</div>
            </div>
            <div>
              <Label>Owner</Label>
              <div className="mt-1">{lead.ownerName ?? 'Unassigned'}</div>
            </div>
            <div>
              <Label>Expected value</Label>
              <div className="mt-1">₹{(lead.expectedValueMinor / 100).toLocaleString('en-IN')}</div>
            </div>
          </div>
          {lead.lossReason ? (
            <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-foam-45">Loss reason: {lead.lossReason}</p>
          ) : null}
        </Panel>

        {lead.trial ? <TrialPanel leadId={lead.id} stage={lead.stage} trial={lead.trial} canManage={canManage} onConfirmed={invalidate} /> : null}

        <EnquiryPanel lead={lead} />

        {canManage && !lead.convertedMemberId ? (
          <Panel title="Actions">
            <div className="flex flex-wrap gap-2 p-3.5">
              {moveableStages.map((s) => (
                <Button key={s} variant="outline" disabled={moveStage.isPending} onClick={() => moveStage.mutate({ to: s })}>
                  Move to {s.replace(/_/g, ' ')}
                </Button>
              ))}
              {data.availableStages.includes('lost') ? (
                <Button variant="danger" disabled={moveStage.isPending} onClick={() => setLossSheet('lost')}>
                  Mark lost
                </Button>
              ) : null}
              {data.availableStages.includes('disqualified') ? (
                <Button variant="danger" disabled={moveStage.isPending} onClick={() => setLossSheet('disqualified')}>
                  Disqualify
                </Button>
              ) : null}
              {canConvert ? (
                <Button variant="cta" disabled={convert.isPending} onClick={() => convert.mutate()}>
                  {convert.isPending ? 'Converting…' : 'Convert to member'}
                </Button>
              ) : null}
            </div>
            {!canConvert && !lead.convertedMemberId ? (
              <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-foam-45">
                Reopen this lead to convert it to a member.
              </p>
            ) : null}
            {convert.isSuccess ? (
              <Panel tone="good">
                <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">{convert.data.message}</p>
              </Panel>
            ) : null}
            {error ? (
              <Panel tone="bad">
                <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">{error}</p>
              </Panel>
            ) : null}
          </Panel>
        ) : null}

        <Panel title="Timeline">
          {canManage ? (
            <div className="flex gap-2 border-b border-line p-3.5">
              <Field label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} className="flex-1" />
              <Button
                variant="outline"
                disabled={!note.trim() || logActivity.isPending}
                onClick={() => logActivity.mutate()}
                className="self-end"
              >
                Log
              </Button>
            </div>
          ) : null}
          <ul className="flex flex-col gap-0 divide-y divide-line">
            {data.activities.length === 0 ? (
              <li className="p-3.5 text-[12px] text-foam-45">No activity yet.</li>
            ) : (
              data.activities.map((a) => (
                <li key={a.id} className="p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.1em] text-foam-45">
                      {a.kind.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[11px] text-foam-35">{new Date(a.at).toLocaleString('en-GB')}</span>
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed">{a.body}</p>
                  <p className="mt-1 text-[11px] text-foam-45">{a.actorName}</p>
                </li>
              ))
            )}
          </ul>
        </Panel>
      </Seam>

      {lossSheet ? (
        <LossSheet
          kind={lossSheet}
          leadName={lead.name}
          isPending={moveStage.isPending}
          onClose={() => setLossSheet(null)}
          onConfirm={(reason) => moveStage.mutate({ to: lossSheet, reason })}
        />
      ) : null}
    </Page>
  );
}

/** Losing or disqualifying a lead is a permanent, reported outcome — it
 *  always states its impact and always requires a reason (UX-A03 acceptance:
 *  every consequential action shows impact + scope before it can be confirmed). */
function LossSheet({
  kind,
  leadName,
  isPending,
  onClose,
  onConfirm,
}: {
  kind: LossKind;
  leadName: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const title = kind === 'lost' ? 'Mark this lead lost' : 'Disqualify this lead';

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => onConfirm(reason.trim())}
      title={title}
      consequence={
        kind === 'lost'
          ? `${leadName} moves out of the active pipeline. This can be reversed later by reopening the lead.`
          : `${leadName} is marked as not a fit for membership. This can be reversed later by reopening the lead.`
      }
      confirmLabel={kind === 'lost' ? 'Mark lost' : 'Disqualify'}
      reasonLabel="Reason"
      reason={reason}
      onReasonChange={setReason}
      pending={isPending}
    />
  );
}

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** What the person told the website, where they came from, and what they agreed to (PF-CRM-005, ENT-PRIV-003). */
function EnquiryPanel({ lead }: { lead: Detail['lead'] }) {
  const utm = lead.utm;
  const campaign = utm ? [utm.source, utm.medium, utm.campaign].filter(Boolean).join(' · ') : lead.campaign;
  const rows: Array<[string, string]> = [];
  if (lead.goal) rows.push(['Goal', lead.goal]);
  if (lead.preferredTime) rows.push(['Best time', lead.preferredTime]);
  if (lead.interestedPlan) rows.push(['Interested in', lead.interestedPlan.name]);
  if (campaign) rows.push(['Campaign', campaign]);
  if (utm?.content || utm?.term) rows.push(['Ad detail', [utm.content, utm.term].filter(Boolean).join(' · ')]);
  if (lead.referralCode) rows.push(['Referral code', lead.referralCode]);
  const consents = lead.consents ?? [];
  if (rows.length === 0 && consents.length === 0) return null;

  return (
    <Panel title="Enquiry">
      {rows.length > 0 ? (
        <dl className="grid grid-cols-2 gap-3 p-3.5 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>
                <Label>{label}</Label>
              </dt>
              <dd className="mt-1 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {consents.length > 0 ? (
        <div className="border-t border-line p-3.5">
          <Label>Consent</Label>
          <ul className="mt-1.5 flex flex-col gap-1 text-[12px] text-foam-80">
            {consents.map((c) => (
              <li key={c.purpose}>
                <Chip tone={c.granted ? 'good' : 'neutral'}>{c.granted ? 'agreed' : 'declined'}</Chip>{' '}
                {c.purpose === 'processing' ? 'Use these details to handle the enquiry' : c.purpose === 'marketing' ? 'Offers and news' : c.purpose}
                <span className="text-foam-50">
                  {' '}
                  · notice {c.noticeVersion} · {formatWhen(c.capturedAt)}
                </span>
              </li>
            ))}
          </ul>
          {!consents.some((c) => c.purpose === 'marketing' && c.granted) ? (
            <p className="mt-2 text-[12px] text-foam-65">Do not add this person to offers or broadcasts.</p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

interface TrialOption {
  id: string;
  label: string;
  trainerName: string | null;
  openSpots: number;
  requested: boolean;
}

const TRIAL_CONFIRMABLE = ['new', 'contacted', 'qualified', 'trial_booked', 'nurture', 'reopened'];

/**
 * The website asks; staff confirm. Confirming records the agreed class and
 * moves the lead to "trial booked". Nothing is booked in the schedule and
 * nothing is sent: the person hears from whoever called them.
 */
function TrialPanel({
  leadId,
  stage,
  trial,
  canManage,
  onConfirmed,
}: {
  leadId: string;
  stage: string;
  trial: NonNullable<Detail['lead']['trial']>;
  canManage: boolean;
  onConfirmed: () => void;
}) {
  const canConfirm = canManage && TRIAL_CONFIRMABLE.includes(stage);
  const [sessionId, setSessionId] = useState('');
  const [note, setNote] = useState('');
  const options = useQuery({
    queryKey: ['lead', leadId, 'trial-options'],
    queryFn: () => api<{ items: TrialOption[] }>(`/admin/leads/${leadId}/trial/options`),
    enabled: canConfirm,
  });
  const chosen = sessionId || options.data?.items.find((o) => o.requested)?.id || '';
  const confirm = useMutation({
    mutationFn: () =>
      api<{ sessionLabel: string }>(`/admin/leads/${leadId}/trial/confirm`, {
        method: 'POST',
        body: { sessionId: chosen, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    onSuccess: () => {
      setNote('');
      setSessionId('');
      onConfirmed();
    },
  });

  return (
    <Panel title="Free trial" tone={trial.confirmedAt ? 'good' : 'accent'}>
      <dl className="grid grid-cols-2 gap-3 p-3.5 text-[13px]">
        <div>
          <dt>
            <Label>Asked for</Label>
          </dt>
          <dd className="mt-1">{trial.sessionLabel ?? trial.preferredTime ?? 'Any time'}</dd>
        </div>
        <div>
          <dt>
            <Label>Requested</Label>
          </dt>
          <dd className="mt-1">{trial.requestedAt ? formatWhen(trial.requestedAt) : '—'}</dd>
        </div>
        {trial.confirmedAt ? (
          <div className="col-span-2">
            <dt>
              <Label>Confirmed</Label>
            </dt>
            <dd className="mt-1">
              <Chip tone="good">confirmed</Chip> {trial.confirmedSessionLabel ?? 'Class removed from the schedule'}
            </dd>
          </div>
        ) : null}
      </dl>
      {canConfirm ? (
        <div className="flex flex-col gap-3 border-t border-line p-3.5">
          {options.isLoading ? (
            <Skeleton className="h-9" />
          ) : options.isError ? (
            <p role="alert" className="text-[12px] text-chum">
              Could not load the upcoming classes.{' '}
              <button type="button" className="underline" onClick={() => void options.refetch()}>
                Try again
              </button>
            </p>
          ) : (options.data?.items.length ?? 0) === 0 ? (
            <p className="text-[12px] text-foam-65">No classes are scheduled at this branch in the next two weeks. Add one in Schedule, then confirm here.</p>
          ) : (
            <>
              <SelectField
                label={trial.confirmedAt ? 'Move the trial to' : 'Class agreed on the call'}
                value={chosen}
                onChange={(e) => setSessionId(e.target.value)}
                options={[
                  ...(chosen ? [] : [{ value: '', label: 'Choose a class' }]),
                  ...(options.data?.items ?? []).map((o) => ({
                    value: o.id,
                    label: `${o.label}${o.trainerName ? ` · ${o.trainerName}` : ''} · ${o.openSpots > 0 ? `${o.openSpots} open` : 'full'}${o.requested ? ' · requested' : ''}`,
                  })),
                ]}
              />
              <Field label="Note for the timeline" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional, e.g. bring a towel" />
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="cta" disabled={!chosen} pending={confirm.isPending} pendingLabel="Confirming…" onClick={() => confirm.mutate()}>
                  {trial.confirmedAt ? 'Change trial class' : 'Confirm trial'}
                </Button>
                <span className="text-[12px] text-foam-65">Records the class on the lead. No seat is booked and nothing is sent to them.</span>
              </div>
              {confirm.isError ? (
                <p role="alert" className="text-[12px] text-chum">
                  {confirm.error instanceof ApiError ? confirm.error.message : 'Could not confirm the trial. Try again.'}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
