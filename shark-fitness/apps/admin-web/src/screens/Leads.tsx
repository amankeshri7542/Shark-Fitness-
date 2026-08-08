import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import { Button, Chip, EmptyState, ErrorState, Field, Panel, PermissionState, Skeleton } from '../ui/console';

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
}

const STAGES = ['new', 'contacted', 'qualified', 'trial_booked', 'trial_completed', 'nurture', 'won', 'lost', 'disqualified'] as const;

export default function LeadsScreen() {
  const canView = usePermission('lead.view');
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['leads', search],
    queryFn: () => api<LeadsPayload>(`/admin/leads${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`),
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
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">
          {breachCount > 0 ? `${breachCount} overdue` : 'All on schedule'}
        </span>
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

      {data.items.length === 0 ? (
        <EmptyState
          title="No leads yet"
          body={search ? 'Nothing matches that search.' : 'Capture your first lead to start the pipeline.'}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearch('')}>
                Clear search
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
    </Page>
  );
}
