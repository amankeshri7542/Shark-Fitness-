import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../../lib/api';
import { useBranchScope, usePermission } from '../../lib/store';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Label,
  Panel,
  PermissionState,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Toolbar,
} from '../../ui/console';
import { useIdempotentAttempt } from '../../lib/idempotent-attempt';

/**
 * Commission (PF-STAFF).
 *
 * Two things this surface says out loud, because both are places a console can
 * quietly mislead:
 *
 * - **Approving is a different permission from reading.** Somebody who may see
 *   the figures and not sign them off gets the numbers and no buttons, with the
 *   reason — rather than buttons that fail on press.
 * - **Marking a line paid moves no money.** It records a payroll settlement
 *   that happened elsewhere, which is why the reference is required and the
 *   wording never implies this system paid anybody.
 */

interface CommissionLine {
  id: string;
  kind: string;
  basisMinor: number;
  ratePct: number;
  amountMinor: number;
  state: string;
  ruleVersion: string;
  refType: string | null;
  refId: string | null;
  branchId: string | null;
  correctionOfLineId: string | null;
  correctionReason: string | null;
  evidence: string[];
  createdAt: number;
}

interface CommissionReport {
  periodStart: string;
  periodEnd: string;
  currency: string;
  staff: Array<{
    staffId: string;
    name: string;
    pendingMinor: number;
    approvedMinor: number;
    paidMinor: number;
    totalMinor: number;
    lines: CommissionLine[];
  }>;
  totals: { pendingMinor: number; approvedMinor: number; paidMinor: number; totalMinor: number };
  settlementNote: string;
}

interface Rules {
  kinds: string[];
  tenantRates: Array<{ kind: string; ratePct: number; version: string; effectiveFrom: string }>;
  unsourcedKinds: string[];
  canApprove: boolean;
}

/** Integer minor units in, a readable amount out — and never a float in
 *  between, because the ledger is integers on purpose. */
function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${currency === 'INR' ? '₹' : ''}${(abs / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function CommissionSurface() {
  const { branchId } = useBranchScope();
  const canView = usePermission('staff.commission');
  const queryClient = useQueryClient();

  const [periodStart, setPeriodStart] = useState(monthStart);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openStaff, setOpenStaff] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<CommissionLine | null>(null);

  const rules = useQuery({
    queryKey: ['staff', 'commission', 'rules'],
    queryFn: () => api<Rules>('/admin/staff/commission/rules', { branchId }),
    enabled: canView,
  });

  const report = useQuery({
    queryKey: ['staff', 'commission', periodStart, periodEnd, branchId],
    queryFn: () =>
      api<CommissionReport>(`/admin/staff/commission?periodStart=${periodStart}&periodEnd=${periodEnd}`, {
        branchId,
      }),
    enabled: canView,
  });

  const attempt = useIdempotentAttempt('admin-commission');

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['staff', 'commission'] });
  };
  const fail = (err: unknown): void =>
    setActionError(err instanceof ApiError ? err.message : 'That did not go through. Nothing has changed.');

  const calculate = useMutation({
    mutationFn: () => {
      const body = { periodStart, periodEnd };
      return api<{ created: number; alreadyAccrued: number; noRate: Array<{ staffId: string }>; totalMinor: number }>(
        '/admin/staff/commission/calculate',
        { method: 'POST', body, branchId, idempotencyKey: attempt.keyFor(body) },
      );
    },
    onSuccess: (result) => {
      attempt.retire();
      setActionError(null);
      setNotice(
        `${result.created} new ${result.created === 1 ? 'line' : 'lines'} accrued` +
          (result.alreadyAccrued > 0 ? `, ${result.alreadyAccrued} already existed` : '') +
          (result.noRate.length > 0
            ? `. ${result.noRate.length} eligible ${
                result.noRate.length === 1 ? 'transaction has' : 'transactions have'
              } no rule and earned nothing.`
            : '.'),
      );
      refresh();
    },
    onError: fail,
  });

  const approve = useMutation({
    mutationFn: (lineIds: string[]) =>
      api<{ approved: string[]; totalMinor: number }>('/admin/staff/commission/approve', {
        method: 'POST',
        body: { lineIds },
        branchId,
      }),
    onSuccess: (result) => {
      setActionError(null);
      setNotice(`Approved ${result.approved.length} ${result.approved.length === 1 ? 'line' : 'lines'}.`);
      refresh();
    },
    onError: fail,
  });

  const markPaid = useMutation({
    mutationFn: (input: { lineIds: string[]; reference: string }) =>
      api<{ paid: string[] }>('/admin/staff/commission/paid', { method: 'POST', body: input, branchId }),
    onSuccess: (result) => {
      setActionError(null);
      setNotice(
        `${result.paid.length} ${
          result.paid.length === 1 ? 'line' : 'lines'
        } recorded as settled by that payroll run. No money moved here.`,
      );
      refresh();
    },
    onError: fail,
  });

  if (!canView) {
    return (
      <Panel title="Commission">
        <PermissionState what="Commission figures" />
      </Panel>
    );
  }

  if (report.isLoading || rules.isLoading) return <Skeleton className="h-64" />;
  if (report.error || !report.data) {
    return (
      <ErrorState
        title="Commission could not be read"
        body={report.error instanceof ApiError ? report.error.message : 'The server did not answer.'}
        onRetry={() => void report.refetch()}
      />
    );
  }

  const data = report.data;
  const canApprove = rules.data?.canApprove ?? false;

  return (
    <>
      {notice ? (
        <Panel tone="good" className="border-b border-line">
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <p className="flex-1 text-[12px] leading-relaxed">{notice}</p>
            <Button variant="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </div>
        </Panel>
      ) : null}
      {actionError ? (
        <Panel tone="bad" className="border-b border-line">
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <p className="flex-1 text-[12px] leading-relaxed">{actionError}</p>
            <Button variant="ghost" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          </div>
        </Panel>
      ) : null}

      <Toolbar>
        <Field label="Period from" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        <Field label="Period to" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        <Button variant="cta" disabled={calculate.isPending} onClick={() => calculate.mutate()}>
          {calculate.isPending ? 'Calculating…' : 'Calculate period'}
        </Button>
      </Toolbar>

      <Panel className="border-b border-line">
        <div className="flex flex-wrap gap-8 p-3.5">
          <div>
            <Label>Pending</Label>
            <div className="mt-1 font-display text-[20px]">{money(data.totals.pendingMinor, data.currency)}</div>
          </div>
          <div>
            <Label>Approved</Label>
            <div className="mt-1 font-display text-[20px]">{money(data.totals.approvedMinor, data.currency)}</div>
          </div>
          <div>
            <Label>Paid</Label>
            <div className="mt-1 font-display text-[20px]">{money(data.totals.paidMinor, data.currency)}</div>
          </div>
        </div>
        <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
          {data.settlementNote}
        </p>
        {!canApprove ? (
          <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
            Your role can read these figures and cannot approve or settle them. That separation is deliberate.
          </p>
        ) : null}
        {rules.data && rules.data.unsourcedKinds.length > 0 ? (
          <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
            Rates are configured for {rules.data.unsourcedKinds.join(', ')}, and this release has no eligible
            transaction to earn them on. Those rules will not pay until one exists.
          </p>
        ) : null}
      </Panel>

      {data.staff.length === 0 ? (
        <EmptyState
          title="Nothing accrued in this period"
          body="Calculate the period to accrue commission from paid sales and settled membership payments."
        />
      ) : (
        <Panel title={`By staff · ${data.staff.length}`}>
          <TableScroll>
            <Table label="Commission by staff">
              <THead>
                <TH>Staff</TH>
                <TH numeric>Pending</TH>
                <TH numeric>Approved</TH>
                <TH numeric>Paid</TH>
                <TH numeric>Total</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </THead>
              <tbody>
                {data.staff.map((entry) => (
                  <TR key={entry.staffId}>
                    <TD>{entry.name}</TD>
                    <TD numeric>{money(entry.pendingMinor, data.currency)}</TD>
                    <TD numeric>{money(entry.approvedMinor, data.currency)}</TD>
                    <TD numeric>{money(entry.paidMinor, data.currency)}</TD>
                    <TD numeric>{money(entry.totalMinor, data.currency)}</TD>
                    <TD>
                      <Button
                        variant="ghost"
                        onClick={() => setOpenStaff(openStaff === entry.staffId ? null : entry.staffId)}
                      >
                        {openStaff === entry.staffId ? 'Close' : 'Lines'}
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Panel>
      )}

      {openStaff && data.staff.some((row) => row.staffId === openStaff) ? (
        <StaffLines
          entry={data.staff.find((row) => row.staffId === openStaff)!}
          currency={data.currency}
          canApprove={canApprove}
          onApprove={(ids) => approve.mutate(ids)}
          onPay={(ids, reference) => markPaid.mutate({ lineIds: ids, reference })}
          onCorrect={setCorrecting}
          pending={approve.isPending || markPaid.isPending}
        />
      ) : null}

      {correcting ? (
        <CorrectionForm
          line={correcting}
          currency={data.currency}
          branchId={branchId}
          onClose={() => setCorrecting(null)}
          onDone={(message) => {
            setCorrecting(null);
            setActionError(null);
            setNotice(message);
            refresh();
          }}
          onError={fail}
        />
      ) : null}
    </>
  );
}

function StaffLines({
  entry,
  currency,
  canApprove,
  onApprove,
  onPay,
  onCorrect,
  pending,
}: {
  entry: CommissionReport['staff'][number];
  currency: string;
  canApprove: boolean;
  onApprove: (lineIds: string[]) => void;
  onPay: (lineIds: string[], reference: string) => void;
  onCorrect: (line: CommissionLine) => void;
  pending: boolean;
}) {
  const [reference, setReference] = useState('');
  const pendingLines = entry.lines.filter((line) => line.state === 'pending').map((line) => line.id);
  const approvedLines = entry.lines.filter((line) => line.state === 'approved').map((line) => line.id);

  return (
    <Panel title={`${entry.name} · ${entry.lines.length} lines`}>
      {canApprove ? (
        <Toolbar className="border-b">
          <Button variant="cta" disabled={pendingLines.length === 0 || pending} onClick={() => onApprove(pendingLines)}>
            Approve {pendingLines.length} pending
          </Button>
          <Field
            label="Payroll reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="PAYROLL-2026-08"
            hint="Where this was actually settled. Recording it moves no money here."
          />
          <Button
            variant="outline"
            disabled={approvedLines.length === 0 || reference.trim().length < 3 || pending}
            onClick={() => onPay(approvedLines, reference.trim())}
          >
            Record {approvedLines.length} as paid
          </Button>
        </Toolbar>
      ) : null}

      <TableScroll>
        <Table label={`Commission lines for ${entry.name}`}>
          <THead>
            <TH>Kind</TH>
            <TH numeric>Basis</TH>
            <TH numeric>Rate</TH>
            <TH numeric>Amount</TH>
            <TH>State</TH>
            <TH>Rule</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </THead>
          <tbody>
            {entry.lines.map((line) => (
              <TR key={line.id}>
                <TD>
                  {line.kind}
                  {line.correctionOfLineId ? <span className="text-foam-45"> · correction</span> : null}
                </TD>
                <TD numeric>{money(line.basisMinor, currency)}</TD>
                <TD numeric>{line.ratePct}%</TD>
                <TD numeric>{money(line.amountMinor, currency)}</TD>
                <TD>
                  <Chip
                    tone={
                      line.state === 'paid'
                        ? 'good'
                        : line.state === 'approved'
                          ? 'accent'
                          : line.state === 'reversed'
                            ? 'bad'
                            : 'neutral'
                    }
                  >
                    {line.state}
                  </Chip>
                </TD>
                <TD>{line.ruleVersion}</TD>
                <TD>
                  {canApprove && !line.correctionOfLineId && line.state !== 'reversed' ? (
                    <Button variant="ghost" onClick={() => onCorrect(line)}>
                      Correct
                    </Button>
                  ) : line.correctionReason ? (
                    <span className="text-[11px] text-foam-45">{line.correctionReason}</span>
                  ) : null}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </Panel>
  );
}

/** A correction never edits the original, and the copy says so — a manager
 *  pressing this needs to know the old figure survives. */
function CorrectionForm({
  line,
  currency,
  branchId,
  onClose,
  onDone,
  onError,
}: {
  line: CommissionLine;
  currency: string;
  branchId: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const [reason, setReason] = useState('');
  const [partial, setPartial] = useState('');

  const correct = useMutation({
    mutationFn: () =>
      api<{ correctionId: string; amountMinor: number }>(`/admin/staff/commission/${line.id}/correct`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          ...(partial.trim() ? { amountMinor: Math.round(Number(partial) * 100) } : {}),
        },
        branchId,
      }),
    onSuccess: (result) =>
      onDone(
        `Correction of ${money(
          result.amountMinor,
          currency,
        )} raised. The original line is unchanged and still shows what it accrued.`,
      ),
    onError,
  });

  return (
    <Panel title="Correct a commission line" tone="bad">
      <p className="border-b border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
        This raises a compensating entry of {money(-line.amountMinor, currency)} against the original. The original
        keeps its amount, its rate and — if it was paid — the payroll run it was settled under. Nothing is rewritten.
      </p>
      <div className="grid grid-cols-1 gap-3 p-3.5 sm:grid-cols-2">
        <Field
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Customer returned the goods."
        />
        <Field
          label="Take back only (optional)"
          type="number"
          min={0}
          step="0.01"
          value={partial}
          onChange={(e) => setPartial(e.target.value)}
          hint={`Leave blank to reverse the whole ${money(line.amountMinor, currency)}.`}
        />
      </div>
      <Toolbar className="border-t">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={reason.trim().length < 4 || correct.isPending}
          onClick={() => correct.mutate()}
        >
          {correct.isPending ? 'Raising…' : 'Raise correction'}
        </Button>
      </Toolbar>
    </Panel>
  );
}
