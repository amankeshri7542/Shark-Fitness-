import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { usePermission } from '../lib/store';
import { Page } from '../ui/shell';
import {
  Bar,
  Button,
  Chip,
  Display,
  ErrorState,
  Field,
  Label,
  Metric,
  Panel,
  Seam,
  Skeleton,
  cx,
  type Tone,
} from '../ui/console';

interface Detail {
  member: {
    id: string;
    memberNo: string;
    name: string;
    initials: string;
    email: string | null;
    phone: string | null;
    dob: string | null;
    emergencyContact: { name: string; phone: string; relationship: string } | null;
    lifecycle: string;
    joinedOn: string;
    lastVisitLabel: string;
    branchName: string;
    trainerName: string | null;
    tags: string[];
    memberNotes: string | null;
    staffNotes?: string | null;
    riskScore: number | null;
    riskBand: 'high' | 'watch' | 'low' | null;
    riskReasons: Array<{ code: string; label: string; points: number }>;
    version: number;
  };
  level: { level: number; name: string; progressPct: number; nextName: string | null };
  membership: {
    id: string;
    productName: string;
    state: string;
    startedOn: string;
    endsOn: string | null;
    autoRenew: boolean;
    freezeDaysUsed: number;
    freezeRules: { allowed: boolean; maxDaysPerTerm: number; minDaysPerFreeze: number; extendsExpiry: boolean };
    cancellation: { noticeDays: number; description: string };
    priceLabel: string;
  } | null;
  membershipHistory: Array<{ id: string; from: string; to: string; reason: string; actorName: string; relativeTime: string }>;
  billing: {
    outstandingLabel: string;
    invoices: Array<{ id: string; number: string; state: string; issuedOn: string; dueOn: string; totalLabel: string; dueMinor: number; dueLabel: string }>;
  } | null;
  credits: Array<{ kind: string; balance: number }>;
  visits: Array<{ id: string; relativeTime: string; granted: boolean; decision: string; minutes: number | null; overrideByName: string | null; overrideReason: string | null }>;
  workouts: Array<{ id: string; title: string; relativeTime: string; volumeKg: number; sets: number; minutes: number }>;
  bookings: Array<{ id: string; name: string; state: string; relativeTime: string }>;
  audit: Array<{ id: string; action: string; actorName: string; reason: string | null; relativeTime: string; changes: Array<{ field: string; from: string; to: string }> }>;
}

const STATE_TONE: Record<string, Tone> = {
  active: 'good',
  trial: 'accent',
  frozen: 'neutral',
  grace: 'warn',
  expired: 'bad',
  suspended: 'bad',
  cancel_scheduled: 'warn',
  cancelled: 'bad',
};

type Sheet = 'freeze' | 'cancel' | null;

export default function MemberDetailScreen() {
  const { memberId } = useParams({ from: '/console/members/$memberId' });
  const queryClient = useQueryClient();
  const canManage = usePermission('membership.manage');
  const [sheet, setSheet] = useState<Sheet>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['member', memberId],
    queryFn: () => api<Detail>(`/admin/members/${memberId}`),
  });

  if (isLoading) return <DetailSkeleton />;

  if (error || !data) {
    return (
      <Page title="Member">
        <ErrorState
          title={error instanceof ApiError && error.status === 403 ? 'Not available to your role' : 'Could not load this member'}
          body={
            error instanceof ApiError
              ? error.message
              : 'The API did not answer. Nothing has changed.'
          }
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  const m = data.member;

  return (
    <Page
      title={m.name}
      kicker={`${m.memberNo} · ${m.branchName}`}
      actions={
        <div className="flex gap-2">
          <Link to="/members">
            <Button variant="ghost">← Directory</Button>
          </Link>
          {canManage && data.membership ? (
            <>
              {data.membership.state === 'frozen' ? (
                <Button variant="outline" onClick={() => setSheet('freeze')}>
                  Unfreeze
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setSheet('freeze')} disabled={!data.membership.freezeRules.allowed}>
                  Freeze
                </Button>
              )}
              <Button variant="danger" onClick={() => setSheet('cancel')}>
                Cancel plan
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {/* Identity strip */}
      <Seam className="border-b border-line">
        <div className="min-w-[190px] flex-1 px-3.5 py-3">
          <Label>Status</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <Chip tone={STATE_TONE[m.lifecycle] ?? 'neutral'}>{m.lifecycle}</Chip>
            {data.membership ? <span className="text-[12px] text-foam-65">{data.membership.productName}</span> : null}
          </div>
          <p className="mt-1.5 text-[11px] text-foam-45">Joined {m.joinedOn}</p>
        </div>
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Last seen</Label>
          <div className="mt-1.5 font-utility text-[15px] font-semibold">{m.lastVisitLabel}</div>
          <p className="mt-1.5 text-[11px] text-foam-45">{m.trainerName ? `Coach ${m.trainerName}` : 'No coach assigned'}</p>
        </div>
        {data.billing ? (
          <div className="min-w-[150px] flex-1 px-3.5 py-3">
            <Label>Outstanding</Label>
            <div className="mt-1.5">
              <Metric
                value={data.billing.outstandingLabel}
                size="md"
                tone={data.billing.invoices.some((i) => i.dueMinor > 0) ? 'bad' : 'good'}
              />
            </div>
          </div>
        ) : null}
        <div className="min-w-[150px] flex-1 px-3.5 py-3">
          <Label>Tier</Label>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <Metric value={data.level.level} size="md" tone="accent" />
            <span className="text-[12px] text-sonar">{data.level.name}</span>
          </div>
          <Bar className="mt-1.5" value={data.level.progressPct} height="h-[3px]" />
        </div>
      </Seam>

      {/* Risk — always with its reasons and a recommended action, never bare. */}
      {m.riskBand && m.riskBand !== 'low' ? (
        <div className={cx('border-b border-line px-4 py-3', m.riskBand === 'high' ? 'bg-wash-chum' : 'bg-wash-flare')}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={m.riskBand === 'high' ? 'text-chum' : 'text-flare'}>
              {m.riskBand === 'high' ? '×' : '!'}
            </span>
            <span className="font-utility text-[12px] font-semibold uppercase tracking-[0.12em]">
              Retention risk {m.riskScore} · {m.riskBand}
            </span>
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {m.riskReasons.map((r) => (
              <li key={r.code} className="text-[12px] text-foam-65">
                {r.label} <span className="text-foam-35">+{r.points}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px]">
        <div className="seam-y flex flex-col border-b border-line xl:border-r">
          <Panel title="Membership">
            {data.membership ? (
              <div className="px-3.5 py-3">
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
                  <div>
                    <Label>Plan</Label>
                    <div className="mt-1 font-utility text-[14px] font-semibold">{data.membership.productName}</div>
                  </div>
                  <div>
                    <Label>Term</Label>
                    <div className="mt-1 text-[13px]">
                      {data.membership.startedOn} → {data.membership.endsOn ?? 'open-ended'}
                    </div>
                  </div>
                  <div>
                    <Label>Price</Label>
                    <div className="mt-1 font-display text-[15px]">{data.membership.priceLabel}</div>
                  </div>
                  <div>
                    <Label>Auto-renew</Label>
                    <div className="mt-1">
                      <Chip tone={data.membership.autoRenew ? 'good' : 'warn'}>
                        {data.membership.autoRenew ? 'on' : 'off'}
                      </Chip>
                    </div>
                  </div>
                  <div>
                    <Label>Freeze used</Label>
                    <div className="mt-1 text-[13px]">
                      {data.membership.freezeDaysUsed} / {data.membership.freezeRules.maxDaysPerTerm} days
                    </div>
                  </div>
                </div>
                <p className="mt-3 border-t border-line pt-2.5 text-[12px] leading-relaxed text-foam-45">
                  {data.membership.cancellation.description}
                </p>
              </div>
            ) : (
              <p className="px-3.5 py-3 text-[13px] text-foam-45">No membership on file.</p>
            )}
          </Panel>

          <Panel title="Recent training">
            {data.workouts.length === 0 ? (
              <p className="px-3.5 py-3 text-[13px] text-foam-45">Nothing logged yet.</p>
            ) : (
              <table className="console-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>When</th>
                    <th className="text-right">Volume</th>
                    <th className="text-right">Sets</th>
                    <th className="text-right">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workouts.map((w) => (
                    <tr key={w.id}>
                      <td className="text-[13px]">{w.title}</td>
                      <td className="text-[12px] text-foam-45">{w.relativeTime}</td>
                      <td data-numeric>{w.volumeKg.toLocaleString('en-IN')} kg</td>
                      <td data-numeric>{w.sets}</td>
                      <td data-numeric>{w.minutes}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {data.billing ? (
            <Panel title="Invoices">
              {data.billing.invoices.length === 0 ? (
                <p className="px-3.5 py-3 text-[13px] text-foam-45">No invoices raised.</p>
              ) : (
                <table className="console-table">
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Issued</th>
                      <th>Due</th>
                      <th>State</th>
                      <th className="text-right">Total</th>
                      <th className="text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.billing.invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="font-utility text-[12px]">{i.number}</td>
                        <td className="text-[12px] text-foam-45">{i.issuedOn}</td>
                        <td className="text-[12px] text-foam-45">{i.dueOn}</td>
                        <td>
                          <Chip
                            tone={i.state === 'paid' ? 'good' : i.state === 'overdue' ? 'bad' : i.state === 'void' ? 'neutral' : 'warn'}
                          >
                            {i.state.replace(/_/g, ' ')}
                          </Chip>
                        </td>
                        <td data-numeric>{i.totalLabel}</td>
                        <td data-numeric className={i.dueMinor > 0 ? 'text-chum' : 'text-foam-25'}>
                          {i.dueMinor > 0 ? i.dueLabel : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          ) : null}
        </div>

        {/* Right rail: contact, timeline, door, audit */}
        <div className="seam-y flex flex-col border-b border-line">
          <Panel title="Contact">
            <dl className="px-3.5 py-3 text-[13px]">
              <div className="flex gap-2 py-1">
                <dt className="w-24 flex-none text-foam-45">Email</dt>
                <dd className="min-w-0 truncate">{m.email ?? '—'}</dd>
              </div>
              <div className="flex gap-2 py-1">
                <dt className="w-24 flex-none text-foam-45">Phone</dt>
                <dd>{m.phone ?? '—'}</dd>
              </div>
              <div className="flex gap-2 py-1">
                <dt className="w-24 flex-none text-foam-45">Born</dt>
                <dd>{m.dob ?? '—'}</dd>
              </div>
              {m.emergencyContact ? (
                <div className="flex gap-2 py-1">
                  <dt className="w-24 flex-none text-foam-45">Emergency</dt>
                  <dd>
                    {m.emergencyContact.name} · {m.emergencyContact.phone}
                    <span className="block text-[11px] text-foam-35">{m.emergencyContact.relationship}</span>
                  </dd>
                </div>
              ) : null}
            </dl>
            {m.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t border-line px-3.5 py-2.5">
                {m.tags.map((t) => (
                  <Chip key={t} tone="neutral" glyph={false}>
                    {t}
                  </Chip>
                ))}
              </div>
            ) : null}
          </Panel>

          {/* Private staff notes are only rendered when the role may read them —
              the key is absent from the payload otherwise. */}
          {'staffNotes' in m ? (
            <Panel title="Private staff notes">
              <p className="px-3.5 py-3 text-[13px] leading-relaxed text-foam-65">
                {m.staffNotes || 'Nothing recorded. These are never shown to the member.'}
              </p>
            </Panel>
          ) : null}

          <Panel title="Membership timeline">
            <ul className="px-3.5 py-2">
              {data.membershipHistory.map((h) => (
                <li key={h.id} className="border-l border-line py-2 pl-3">
                  <div className="text-[12px]">
                    <span className="text-foam-45">{h.from}</span>
                    <span aria-hidden="true" className="mx-1.5 text-foam-25">
                      →
                    </span>
                    <span className="text-foam">{h.to}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-foam-45">{h.reason}</div>
                  <div className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">
                    {h.actorName} · {h.relativeTime}
                  </div>
                </li>
              ))}
              {data.membershipHistory.length === 0 ? (
                <li className="py-2 text-[12px] text-foam-45">No state changes recorded.</li>
              ) : null}
            </ul>
          </Panel>

          <Panel title="Door history">
            <ul>
              {data.visits.slice(0, 8).map((v) => (
                <li key={v.id} className="flex items-center gap-2.5 border-b border-line-10 px-3.5 py-2 last:border-0">
                  <span aria-hidden="true" className={cx('h-1.5 w-1.5 flex-none', v.granted ? 'bg-kelp' : 'bg-chum')} />
                  <span className="flex-1 text-[12px]">{v.relativeTime}</span>
                  {v.overrideByName ? (
                    <span title={v.overrideReason ?? ''}>
                      <Chip tone="warn">override</Chip>
                    </span>
                  ) : !v.granted ? (
                    <Chip tone="bad">denied</Chip>
                  ) : (
                    <span className="font-utility text-[11px] tabular-nums text-foam-45">
                      {v.minutes !== null ? `${v.minutes}m` : 'inside'}
                    </span>
                  )}
                </li>
              ))}
              {data.visits.length === 0 ? (
                <li className="px-3.5 py-3 text-[12px] text-foam-45">Never checked in.</li>
              ) : null}
            </ul>
          </Panel>

          {data.audit.length > 0 ? (
            <Panel title="Audit">
              <ul>
                {data.audit.map((a) => (
                  <li key={a.id} className="border-b border-line-10 px-3.5 py-2 last:border-0">
                    <div className="font-utility text-[11px] font-semibold uppercase tracking-[0.1em] text-foam-65">
                      {a.action.replace(/[._]/g, ' ')}
                    </div>
                    <div className="mt-0.5 text-[11px] text-foam-45">
                      {a.actorName} · {a.relativeTime}
                      {a.reason ? ` · ${a.reason}` : ''}
                    </div>
                    {a.changes.slice(0, 3).map((ch) => (
                      <div key={ch.field} className="mt-0.5 text-[11px] text-foam-35">
                        {ch.field}: {ch.from} → {ch.to}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </div>

      {sheet ? (
        <ActionSheet
          kind={sheet}
          detail={data}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            void queryClient.invalidateQueries({ queryKey: ['member', memberId] });
            void queryClient.invalidateQueries({ queryKey: ['members'] });
          }}
        />
      ) : null}
    </Page>
  );
}

/** Every destructive or financially significant action states its impact,
 *  its scope, and when it takes effect before it can be confirmed. */
function ActionSheet({ kind, detail, onClose, onDone }: {
  kind: 'freeze' | 'cancel';
  detail: Detail;
  onClose: () => void;
  onDone: () => void;
}) {
  const frozen = detail.membership?.state === 'frozen';
  const [days, setDays] = useState(String(detail.membership?.freezeRules.minDaysPerFreeze ?? 7));
  const [reason, setReason] = useState('');
  const [immediate, setImmediate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => {
      const base = `/admin/members/${detail.member.id}`;
      if (kind === 'freeze') {
        return frozen
          ? api(`${base}/unfreeze`, { method: 'POST', body: { reason } })
          : api(`${base}/freeze`, { method: 'POST', body: { days: Number(days), reason } });
      }
      return api(`${base}/cancel`, { method: 'POST', body: { reason, immediate } });
    },
    onSuccess: onDone,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });

  const title =
    kind === 'freeze' ? (frozen ? 'Unfreeze this membership' : 'Freeze this membership') : 'Cancel this membership';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6" onClick={onClose} role="presentation">
      <div
        className="w-[min(520px,100%)] border border-line-strong bg-overlay"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="border-b border-line px-4 py-3">
          <Display size="sm" as="h2">
            {title}
          </Display>
        </header>

        <div className="flex flex-col gap-3.5 p-4">
          {kind === 'freeze' && !frozen ? (
            <>
              <Field
                label="Days"
                type="number"
                min={detail.membership?.freezeRules.minDaysPerFreeze ?? 1}
                max={detail.membership?.freezeRules.maxDaysPerTerm ?? 90}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                hint={`Minimum ${detail.membership?.freezeRules.minDaysPerFreeze} days. ${detail.membership?.freezeDaysUsed ?? 0} of ${detail.membership?.freezeRules.maxDaysPerTerm} used this term.`}
              />
              <Panel>
                <p className="px-3 py-2.5 text-[12px] leading-relaxed text-foam-65">
                  {detail.membership?.freezeRules.extendsExpiry
                    ? `The end date moves out by ${days || 0} days. Access pauses for that period.`
                    : 'This plan does not extend the end date when frozen — the member loses those days.'}
                </p>
              </Panel>
            </>
          ) : null}

          {kind === 'cancel' ? (
            <>
              <Panel tone="warn">
                <p className="px-3 py-2.5 text-[12px] leading-relaxed text-foam-80">
                  {detail.membership?.cancellation.description}
                </p>
              </Panel>
              <label className="flex items-center gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={immediate}
                  onChange={(e) => setImmediate(e.target.checked)}
                  className="h-4 w-4 accent-[var(--sf-sonar)]"
                />
                Cancel immediately, waiving the {detail.membership?.cancellation.noticeDays}-day notice
              </label>
              <p className="text-[12px] leading-relaxed text-foam-45">
                {immediate
                  ? 'Access ends now. This cannot be undone — a new membership would have to be created.'
                  : `Access continues through the notice period. The member keeps their bookings until then.`}
              </p>
            </>
          ) : null}

          <Field
            label="Reason"
            placeholder="Recorded in the audit log"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint="Required. Shown in the member's timeline and the audit trail."
          />

          {error ? (
            <Panel tone="bad">
              <p className="px-3 py-2.5 text-[12px] leading-relaxed">{error}</p>
            </Panel>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button variant="ghost" onClick={onClose}>
            Never mind
          </Button>
          <Button
            variant={kind === 'cancel' ? 'danger' : 'cta'}
            size="md"
            disabled={reason.trim().length < 4 || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Working…' : kind === 'cancel' ? 'Cancel membership' : frozen ? 'Unfreeze' : 'Freeze'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <Page title="Member" kicker="Loading">
      <Seam className="border-b border-line">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="min-w-[150px] flex-1 px-3.5 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-6 w-24" />
          </div>
        ))}
      </Seam>
      <Skeleton className="m-4 h-64" />
    </Page>
  );
}
