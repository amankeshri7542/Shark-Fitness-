import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, ErrorState, Field, Label, Panel, PermissionState, Seam, Skeleton, type Tone } from '../ui/console';

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
  };
  activities: Activity[];
  availableStages: string[];
  duplicate: { id: string; name: string } | null;
  ownerUnavailable: boolean;
  existingMember: { id: string; name: string } | null;
}

const STAGE_TONE: Record<string, Tone> = { won: 'good', lost: 'bad', disqualified: 'bad', nurture: 'warn' };

export default function LeadDetailScreen() {
  const { leadId } = useParams({ from: '/console/leads/$leadId' });
  const queryClient = useQueryClient();
  const canView = usePermission('lead.view');
  const canManage = usePermission('lead.manage');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  if (!canView) {
    return (
      <Page title="Lead">
        <PermissionState what="This lead" />
      </Page>
    );
  }

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const moveStage = useMutation({
    mutationFn: (to: string) => api(`/admin/leads/${leadId}/stage`, { method: 'POST', body: { to } }),
    onSuccess: invalidate,
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
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

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

  return (
    <Page title={lead.name} kicker={`${lead.branchName} · ${lead.source.replace(/_/g, ' ')}`}>
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
        </Panel>

        {canManage && !lead.convertedMemberId ? (
          <Panel title="Actions">
            <div className="flex flex-wrap gap-2 p-3.5">
              {data.availableStages
                .filter((s) => !['lost', 'disqualified'].includes(s))
                .map((s) => (
                  <Button key={s} variant="outline" disabled={moveStage.isPending} onClick={() => moveStage.mutate(s)}>
                    Move to {s.replace(/_/g, ' ')}
                  </Button>
                ))}
              {data.availableStages.includes('lost') ? (
                <Button variant="danger" disabled={moveStage.isPending} onClick={() => moveStage.mutate('lost')}>
                  Mark lost
                </Button>
              ) : null}
              {lead.stage === 'trial_completed' || lead.stage === 'won' ? (
                <Button variant="cta" disabled={convert.isPending} onClick={() => convert.mutate()}>
                  {convert.isPending ? 'Converting…' : 'Convert to member'}
                </Button>
              ) : null}
            </div>
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
    </Page>
  );
}
