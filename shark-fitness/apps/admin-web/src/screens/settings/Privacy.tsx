import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BusinessProfile } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Panel,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Toolbar,
} from '../../ui/console';
import { SettingsSection } from './shared';

type Profile = BusinessProfile & { slug: string; plan: string; status: string };

/**
 * Data processing (PF-TEN-001).
 *
 * Four fields, and every one of them is a promise to a person rather than a
 * switch. The retention window decides when a departed member's record is
 * anonymised; the contact is where a subject-access request lands; the consent
 * version is what a member agreed to, which is why raising it here does not
 * re-consent anybody — each consent row stores the version it was granted
 * under.
 */
export default function Privacy({ canManage }: { canManage: boolean }) {
  return (
    <>
      <DataProcessingSection canManage={canManage} />
      <RequestQueue canManage={canManage} />
    </>
  );
}

function DataProcessingSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['settings', 'business'],
    queryFn: () => api<Profile>('/admin/settings/business'),
    enabled: canManage,
  });

  const [draft, setDraft] = useState<Profile['dataProcessing'] | undefined>(undefined);
  const [dirty, setDirty] = useState(false);

  const save = useMutation({
    mutationFn: (dataProcessing: Profile['dataProcessing']) =>
      api<Profile>('/admin/settings/business', { method: 'PATCH', body: { dataProcessing } }),
    onSuccess: (next) => {
      queryClient.setQueryData(['settings', 'business'], next);
      void queryClient.invalidateQueries({ queryKey: ['settings', 'setup'] });
      setDraft(undefined);
      setDirty(false);
    },
  });

  if (!canManage) return null;
  if (profile.isLoading) return <Skeleton className="h-64" />;
  if (profile.error || !profile.data) {
    return (
      <ErrorState
        title="Settings could not be read"
        body={profile.error instanceof ApiError ? profile.error.message : 'The server did not answer.'}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const value = draft ??
    profile.data.dataProcessing ?? {
      privacyContact: '',
      retentionDays: 1095,
      consentVersion: '',
      jurisdiction: '',
    };
  const edit = (patch: Partial<NonNullable<Profile['dataProcessing']>>): void => {
    setDraft({ ...value, ...patch });
    setDirty(true);
  };

  return (
    <SettingsSection
      title="Data processing"
      description="Who a member writes to about their data, how long you keep it, and which version of your terms is in force."
      dirty={dirty}
      pending={save.isPending}
      error={save.isError ? (save.error instanceof ApiError ? save.error.message : 'That could not be saved.') : null}
      onReset={() => {
        setDraft(undefined);
        setDirty(false);
      }}
      onSave={() => save.mutate(value)}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field
          label="Privacy contact"
          hint="Where a member's request to see or delete their data arrives."
          placeholder="privacy@yourgym.com"
          value={value.privacyContact}
          onChange={(e) => edit({ privacyContact: e.target.value })}
        />
        <Field
          label="Jurisdiction"
          hint="The rules you operate under. Recorded, not enforced."
          placeholder="India — DPDP Act 2023"
          value={value.jurisdiction}
          onChange={(e) => edit({ jurisdiction: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field
          label="Retention after leaving (days)"
          type="number"
          min={30}
          max={3650}
          hint="A departed member's record is anonymised after this. Tax rules usually set a floor."
          value={value.retentionDays}
          onChange={(e) => edit({ retentionDays: Number(e.target.value) })}
        />
        <Field
          label="Consent version"
          hint="Raising this does not re-consent anyone — each member's consent records the version they agreed to."
          placeholder="2026-01"
          value={value.consentVersion}
          onChange={(e) => edit({ consentVersion: e.target.value })}
        />
      </div>
    </SettingsSection>
  );
}

/* ============================================================================
   Data-subject requests and legal holds (PF-COMP).

   The queue a privacy contact actually works from. Three things it is careful
   to show rather than imply:

   - **A blocked request looks blocked.** A legal hold puts a deletion into its
     own state, and this table shows that state rather than a request that
     merely looks slow.
   - **The retention window is a reason, not a mystery.** When erasure is
     refused, the date it runs to is on the screen.
   - **Nothing is delivered.** There is no email provider and no storage, so
     the export is produced here and handed over by a person — said on the
     queue, not only in the member's own message.
   ========================================================================= */

interface PrivacyRequest {
  id: string;
  kind: 'export' | 'deletion' | string;
  state: string;
  subjectUserId: string;
  subjectName: string;
  submittedAt: number;
  reviewedAt: number | null;
  completedAt: number | null;
  outcomeNote: string | null;
  artifactId: string | null;
  onLegalHold: boolean;
}

interface RequestDetail {
  request: PrivacyRequest;
  legalHold: { id: string; reason: string; reference: string | null; placedAt: number } | null;
  retention: {
    retentionDays: number;
    jurisdiction: string | null;
    retainUntil: string | null;
    relationshipEndedOn: string | null;
    withinRetentionWindow: boolean;
    preserved: Array<{ table: string; reason: string }>;
  };
  plan: {
    pseudonym: string;
    overwrites: Array<{ table: string; field: string }>;
    blockers: string[];
  } | null;
  artifact: { id: string; checksum: string; byteSize: number; generatedAt: number } | null;
}

const STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'accent' | 'neutral'> = {
  submitted: 'accent',
  in_review: 'warn',
  on_hold: 'bad',
  completed: 'good',
  refused: 'neutral',
};

function RequestQueue({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['privacy', 'requests'],
    queryFn: () =>
      api<{ requests: PrivacyRequest[]; deliveryNote: string }>('/admin/privacy/requests'),
    enabled: canManage,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['privacy'] });
  };
  const fail = (err: unknown): void =>
    setActionError(err instanceof ApiError ? err.message : 'That did not go through. Nothing has changed.');

  if (!canManage) return null;
  if (list.isLoading) return <Skeleton className="h-40" />;
  if (list.error || !list.data) {
    return (
      <ErrorState
        title="The request queue could not be read"
        body={list.error instanceof ApiError ? list.error.message : 'The server did not answer.'}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const rows = list.data.requests;

  return (
    <Panel title={`Data requests · ${rows.length}`}>
      {notice ? (
        <div className="flex items-start gap-3 border-b border-line bg-wash-sonar-soft px-3.5 py-2.5">
          <p className="flex-1 text-[12px] leading-relaxed">{notice}</p>
          <Button variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {actionError ? (
        <div className="flex items-start gap-3 border-b border-line px-3.5 py-2.5">
          <p className="flex-1 text-[12px] leading-relaxed text-signal-bad">{actionError}</p>
          <Button variant="ghost" onClick={() => setActionError(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      <p className="border-b border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
        {list.data.deliveryNote}
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No open requests" body="Nobody has asked to see or delete their data." />
      ) : (
        <TableScroll>
          <Table label="Data-subject requests">
            <THead>
              <TH>Person</TH>
              <TH>Asked for</TH>
              <TH>State</TH>
              <TH>Submitted</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>{row.subjectName}</TD>
                  <TD>{row.kind === 'export' ? 'A copy of their data' : 'Erasure'}</TD>
                  <TD>
                    <Chip tone={STATE_TONE[row.state] ?? 'neutral'}>{row.state.replace(/_/g, ' ')}</Chip>
                    {row.onLegalHold ? (
                      <span className="ml-2">
                        <Chip tone="bad">legal hold</Chip>
                      </span>
                    ) : null}
                  </TD>
                  <TD>{new Date(row.submittedAt).toLocaleDateString()}</TD>
                  <TD>
                    <Button variant="ghost" onClick={() => setOpen(open === row.id ? null : row.id)}>
                      {open === row.id ? 'Close' : 'Open'}
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}

      {open ? (
        <RequestDetailPane
          requestId={open}
          onDone={(message) => {
            setActionError(null);
            setNotice(message);
            refresh();
          }}
          onError={fail}
        />
      ) : null}
    </Panel>
  );
}

function RequestDetailPane({
  requestId,
  onDone,
  onError,
}: {
  requestId: string;
  onDone: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const detail = useQuery({
    queryKey: ['privacy', 'requests', requestId],
    queryFn: () => api<RequestDetail>(`/admin/privacy/requests/${requestId}`),
  });

  const generate = useMutation({
    mutationFn: () =>
      api<{ artifactId: string; checksum: string; byteSize: number; delivery: { message: string } }>(
        `/admin/privacy/requests/${requestId}/export`,
        { method: 'POST' },
      ),
    onSuccess: (result) => {
      void detail.refetch();
      onDone(`Package built — ${result.byteSize} bytes, checksum ${result.checksum.slice(0, 12)}…. ${result.delivery.message}`);
    },
    onError,
  });

  const erase = useMutation({
    mutationFn: () =>
      api<{ pseudonym: string; applied: number }>(`/admin/privacy/requests/${requestId}/erase`, { method: 'POST' }),
    onSuccess: (result) => {
      void detail.refetch();
      onDone(
        `Erased. ${result.applied} personal fields overwritten and the person is now "${result.pseudonym}". ` +
          'Invoices, payments, consents and the audit trail are untouched and still balance.',
      );
    },
    onError,
  });

  if (detail.isLoading) return <Skeleton className="h-40" />;
  if (!detail.data) return null;

  const { request, legalHold, retention, plan, artifact } = detail.data;

  return (
    <div className="border-t border-line bg-wash-sonar-soft">
      <div className="flex flex-wrap gap-6 px-3.5 py-3 text-[12px]">
        <div>
          <Label>Retention</Label>
          <div className="mt-1">
            {retention.retentionDays} days
            {retention.retainUntil ? ` · keep until ${retention.retainUntil}` : ' · membership still live'}
          </div>
        </div>
        {retention.jurisdiction ? (
          <div>
            <Label>Jurisdiction</Label>
            <div className="mt-1">{retention.jurisdiction}</div>
          </div>
        ) : null}
        {artifact ? (
          <div>
            <Label>Package</Label>
            <div className="mt-1">
              {artifact.byteSize} bytes · {artifact.checksum.slice(0, 12)}…
            </div>
          </div>
        ) : null}
      </div>

      {legalHold ? (
        <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-signal-bad">
          Legal hold in force: {legalHold.reason}
          {legalHold.reference ? ` (${legalHold.reference})` : ''}. Erasure is refused until it is released.
        </p>
      ) : null}

      {plan ? (
        <div className="border-t border-line px-3.5 py-2.5">
          <Label>What erasure would do</Label>
          <p className="mt-1 text-[11px] leading-relaxed text-foam-45">
            Overwrites {plan.overwrites.length} personal fields with “{plan.pseudonym}”. It deletes nothing: the
            records below keep pointing at a person who can no longer be identified from them.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {retention.preserved.map((row) => (
              <Chip key={row.table} tone="neutral" glyph={false}>
                {row.table}
              </Chip>
            ))}
          </div>
          {plan.blockers.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-signal-warn">
              {plan.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Toolbar className="border-t">
        {request.kind === 'export' ? (
          <Button variant="cta" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? 'Building…' : artifact ? 'Rebuild package' : 'Build package'}
          </Button>
        ) : (
          <Button
            variant="danger"
            disabled={erase.isPending || request.state === 'completed' || (plan?.blockers.length ?? 0) > 0}
            onClick={() => erase.mutate()}
          >
            {erase.isPending ? 'Erasing…' : 'Apply erasure'}
          </Button>
        )}
      </Toolbar>
    </div>
  );
}
