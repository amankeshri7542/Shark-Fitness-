import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { useAdmin, usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Field, Panel, PermissionState, SelectField, Skeleton } from '../ui/console';
import { Modal } from '../ui/overlay';

interface LeadRow {
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
  slaBreached: boolean;
  duplicateOfId: string | null;
  convertedMemberId: string | null;
}

interface LeadsPayload {
  total: number;
  byStage: Record<string, number>;
  items: LeadRow[];
  hasMore: boolean;
}

const STAGES = ['new', 'contacted', 'qualified', 'trial_booked', 'trial_completed', 'nurture', 'won', 'lost', 'disqualified'] as const;

const SOURCES = [
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'web_form', label: 'Web form' },
  { value: 'referral', label: 'Referral' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'trial', label: 'Trial' },
  { value: 'call', label: 'Call' },
  { value: 'import', label: 'Import' },
  { value: 'api', label: 'API' },
] as const;

export default function LeadsScreen() {
  const canView = usePermission('lead.view');
  const canManage = usePermission('lead.manage');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['leads', search],
    queryFn: () => api<LeadsPayload>(`/admin/leads?limit=500${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`),
    enabled: canView,
  });

  if (!canView) {
    return (
      <Page title="Leads">
        <PermissionState what="The lead pipeline" />
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page title="Leads" kicker="Loading">
        <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </Page>
    );
  }

  if (error || !data) {
    return (
      <Page title="Leads">
        <ErrorState
          title="Could not load the pipeline"
          body="The API did not answer. Nothing has changed."
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  const breachCount = data.items.filter((l) => l.slaBreached).length;

  return (
    <Page
      title="Leads"
      kicker={`${data.total} in view`}
      actions={
        <div className="flex items-center gap-3">
          <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
            {breachCount > 0 ? `${breachCount} overdue` : 'All on schedule'}
          </span>
          {canManage ? (
            <Button variant="cta" onClick={() => setShowCreate(true)}>
              New lead
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="border-b border-line p-3.5">
        <Field
          label="Search"
          placeholder="Name, phone or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-[320px]"
        />
      </div>

      {data.hasMore ? (
        <Panel tone="warn" className="border-b border-line">
          <p className="px-3.5 py-2.5 text-[12px] leading-relaxed">
            Showing {data.items.length} of {data.total} leads. Narrow your search to see the rest — the board does not hide them, it
            just can't fit that many in one request.
          </p>
        </Panel>
      ) : null}

      {data.items.length === 0 ? (
        <EmptyState
          title="No leads yet"
          body={search ? 'Nothing matches that search.' : 'Capture your first lead to start the pipeline.'}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearch('')}>
                Clear search
              </Button>
            ) : canManage ? (
              <Button variant="cta" onClick={() => setShowCreate(true)}>
                New lead
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid min-w-0 grid-flow-col auto-cols-[260px] gap-px overflow-x-auto bg-line">
          {STAGES.map((stage) => {
            const items = data.items.filter((l) => l.stage === stage);
            return (
              <Panel key={stage} title={`${stage.replace(/_/g, ' ')} · ${data.byStage[stage] ?? 0}`} className="bg-hull">
                <ul className="flex flex-col gap-2 p-2.5">
                  {items.map((lead) => (
                    <li key={lead.id}>
                      <Link
                        to="/leads/$leadId"
                        params={{ leadId: lead.id }}
                        className="block border border-line-strong p-2.5 hover:border-sonar"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[13px]">{lead.name}</span>
                          {lead.slaBreached ? <Chip tone="bad">overdue</Chip> : null}
                        </div>
                        <div className="mt-1 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">
                          {lead.branchName} · {lead.source.replace(/_/g, ' ')}
                        </div>
                        {lead.duplicateOfId ? (
                          <Chip tone="warn" className="mt-1.5">
                            possible duplicate
                          </Chip>
                        ) : null}
                        {lead.nextActionLabel ? (
                          <div className="mt-1.5 text-[11px] text-foam-65">{lead.nextActionLabel}</div>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                  {items.length === 0 ? <li className="p-2 text-[11px] text-foam-35">Empty</li> : null}
                </ul>
              </Panel>
            );
          })}
        </div>
      )}

      {showCreate ? <CreateLeadSheet onClose={() => setShowCreate(false)} /> : null}
    </Page>
  );
}

interface Owner {
  id: string;
  name: string;
}

/** UX-A02 "Add lead": name/contact/source/branch/owner/value/next action/tags,
 *  with loading, validation, error, and an explicit duplicate-warning state
 *  that never silently merges — the new lead is always created as its own
 *  record and left for a person to review. */
function CreateLeadSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const branches = useAdmin((s) => s.branches);
  const activeBranchId = useAdmin((s) => s.activeBranchId);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState<string>('walk_in');
  const [campaign, setCampaign] = useState('');
  const [branchId, setBranchId] = useState(activeBranchId ?? branches[0]?.id ?? '');
  const [ownerId, setOwnerId] = useState('');
  const [expectedValue, setExpectedValue] = useState('');
  const [nextActionLabel, setNextActionLabel] = useState('');
  const [tags, setTags] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const owners = useQuery({
    queryKey: ['leads', 'owners', branchId],
    queryFn: () => api<{ items: Owner[] }>(`/admin/leads/owners?branchId=${branchId}`),
    enabled: Boolean(branchId),
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; duplicateOfId: string | null }>('/admin/leads', {
        method: 'POST',
        body: {
          name: name.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          source,
          ...(campaign.trim() ? { campaign: campaign.trim() } : {}),
          branchId,
          ...(ownerId ? { ownerId } : {}),
          expectedValueMinor: expectedValue.trim() ? Math.round(Number(expectedValue) * 100) : 0,
          ...(nextActionLabel.trim() ? { nextActionLabel: nextActionLabel.trim() } : {}),
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
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
    if (!phone.trim() && !email.trim()) {
      setFieldError('Add a phone number or an email so this lead can be reached.');
      return;
    }
    create.mutate();
  };

  const apiErrorMessage = create.error instanceof ApiError ? create.error.message : create.isError ? 'That did not work.' : null;

  // Success with a flagged duplicate: keep the sheet open so staff can review
  // before dismissing it, rather than closing and losing the warning.
  if (create.isSuccess && create.data.duplicateOfId) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Lead created"
        width="w-[min(480px,100%)]"
        footer={
          <>
            <Link to="/leads/$leadId" params={{ leadId: create.data.duplicateOfId }} onClick={onClose}>
              <Button variant="outline">View the other lead</Button>
            </Link>
            <Link to="/leads/$leadId" params={{ leadId: create.data.id }} onClick={onClose}>
              <Button variant="cta">View this lead</Button>
            </Link>
          </>
        }
      >
        <div className="p-4">
          <Panel tone="warn">
            <p className="px-3 py-2.5 text-[12px] leading-relaxed text-foam-80">
              {name.trim()} was created, but may be the same person as an existing lead. Both records exist separately —
              review them and merge if they match.
            </p>
          </Panel>
        </div>
      </Modal>
    );
  }

  if (create.isSuccess) {
    onClose();
    return null;
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New lead"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="cta" size="md" pending={create.isPending} pendingLabel="Creating…" onClick={submit}>
            Create lead
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 p-4">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 …" />
            <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              options={SOURCES.map((s) => ({ value: s.value, label: s.label }))}
            />
            <Field label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Optional" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Branch"
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setOwnerId('');
              }}
              options={[
                { value: '', label: 'Choose a branch' },
                ...branches.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
            <SelectField
              label="Owner"
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              disabled={!branchId || owners.isLoading}
              options={[
                { value: '', label: 'Unassigned (defaults to you)' },
                ...(owners.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
              ]}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Expected value (₹)"
              type="number"
              min={0}
              value={expectedValue}
              onChange={(e) => setExpectedValue(e.target.value)}
              placeholder="0"
            />
            <Field
              label="Next action"
              value={nextActionLabel}
              onChange={(e) => setNextActionLabel(e.target.value)}
              placeholder="e.g. Call tomorrow"
            />
          </div>

          <Field label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} hint="Comma-separated" placeholder="corporate, referred" />

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
    </Modal>
  );
}
