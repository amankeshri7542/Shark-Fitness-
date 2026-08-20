import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from '@tanstack/react-query';
import type {
  AttendanceReport,
  MembershipReport,
  ReportExport,
  ReportKind,
  RetentionReport,
  RevenueReport,
  TrainerReport,
} from '@shark/contracts';
import { ApiError, OfflineError, api } from '../lib/api';
import { useBranchTimeZone, usePermission, useAdmin } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import {
  Button,
  ErrorState,
  Label,
  PermissionState,
  SelectField,
  Skeleton,
  Tabs,
  Toolbar,
} from '../ui/console';
import { Modal } from '../ui/overlay';
import Revenue from './reports/Revenue';
import Membership from './reports/Membership';
import Attendance from './reports/Attendance';
import Trainer from './reports/Trainer';
import Retention from './reports/Retention';

/* ============================================================================
   Reports (PF-RPT-001…006).

   The shape of this screen is a deliberate refusal of the dashboard idiom. A
   wall of rounded KPI cards answers "how are we doing" — a question nobody
   actually opens a console to ask. The questions this module gets are
   "what did Koramangala take last month", "which coach has empty classes" and
   "who is about to leave", and every one of them is answered by a table with a
   period and a scope stated above it.

   So: one restrained strip of figures for orientation, a toolbar that makes
   the period and the branch obvious and changeable, a small trend where a
   direction matters, and the table as the evidence.

   Which report, which range and which branch all live in the URL, because a
   report is something people send each other.
   ========================================================================= */

const TABS: Array<{ key: ReportKind; label: string }> = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'membership', label: 'Membership' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'trainer', label: 'Coaches' },
  { key: 'retention', label: 'Retention' },
];

/** Presets, because almost every request is one of these four. */
const PRESETS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last 12 months', days: 365 },
];

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  return { from: isoDay(new Date(today.getTime() - 29 * 86_400_000)), to: isoDay(today) };
}

export default function ReportsScreen() {
  const search = useSearch({ strict: false }) as {
    tab?: ReportKind;
    from?: string;
    to?: string;
    branchId?: string;
  };
  const navigate = useNavigate({ from: '/reports' });
  const canView = usePermission('report.view');
  const canExport = usePermission('report.export');
  const timeZone = useBranchTimeZone();
  const online = useOnline();
  const branches = useAdmin((s) => s.branches);
  const [exported, setExported] = useState<ReportExport | null>(null);

  const tab: ReportKind = search.tab ?? 'revenue';
  const fallback = defaultRange();
  const from = search.from ?? fallback.from;
  const to = search.to ?? fallback.to;
  const branchId = search.branchId ?? '';

  const setSearch = (next: Partial<{ tab: ReportKind; from: string; to: string; branchId: string }>): void => {
    void navigate({
      search: (current: Record<string, unknown>) => {
        const merged = { ...current, tab, from, to, ...(branchId ? { branchId } : {}), ...next };
        // An empty branch means "everything I can see", which is the absence of
        // the parameter rather than a value.
        if (!merged.branchId) delete merged.branchId;
        return merged;
      },
      replace: true,
    });
  };

  const query = `from=${from}&to=${to}${branchId ? `&branchId=${encodeURIComponent(branchId)}` : ''}`;

  const report = useQuery({
    queryKey: ['reports', tab, from, to, branchId],
    queryFn: () => api<unknown>(`/admin/reports/${tab}?${query}`),
    enabled: canView,
    // A report is a settled figure, not a ticker. Refetching it under the
    // reader while they are reading it is how two people end up quoting two
    // numbers from the same screen.
    staleTime: 60_000,
  });

  const runExport = useMutation({
    mutationFn: () =>
      api<ReportExport>('/admin/reports/export', {
        method: 'POST',
        body: { kind: tab, from, to, ...(branchId ? { branchId } : {}) },
      }),
    onSuccess: setExported,
  });

  if (!canView) {
    return (
      <Page title="Reports">
        <PermissionState what="Reports and analytics" />
      </Page>
    );
  }

  const applyPreset = (days: number): void => {
    const today = new Date();
    setSearch({ from: isoDay(new Date(today.getTime() - (days - 1) * 86_400_000)), to: isoDay(today) });
  };

  return (
    <Page
      title="Reports"
      kicker={TABS.find((t) => t.key === tab)?.label}
      actions={
        <Button
          variant="outline"
          disabled={!canExport || !online || !report.data}
          pending={runExport.isPending}
          pendingLabel="Preparing…"
          onClick={() => runExport.mutate()}
        >
          {canExport ? 'Export CSV' : 'Export not permitted'}
        </Button>
      }
    >
      <Tabs
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        active={tab}
        label="Reports"
        onChange={(key) => setSearch({ tab: key as ReportKind })}
      />

      <Toolbar>
        <Label>Period</Label>
        <input
          type="date"
          aria-label="From"
          className="sf-field !min-h-9 !w-auto !py-1.5 !text-[13px]"
          value={from}
          max={to}
          onChange={(e) => e.target.value && setSearch({ from: e.target.value })}
        />
        <span className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">to</span>
        <input
          type="date"
          aria-label="To"
          className="sf-field !min-h-9 !w-auto !py-1.5 !text-[13px]"
          value={to}
          min={from}
          onChange={(e) => e.target.value && setSearch({ to: e.target.value })}
        />
        {PRESETS.map((p) => (
          <Button key={p.key} variant="ghost" onClick={() => applyPreset(p.days)}>
            {p.label}
          </Button>
        ))}
        {/* No `flex-1` spacer before this: the toolbar wraps, and a growing
            spacer turns a wrap into a full-width break that reads as an
            accident rather than a second row of filters. */}
        <SelectField
          label="Branch"
          className="!flex-row !items-center !gap-2"
          value={branchId}
          onChange={(e) => setSearch({ branchId: e.target.value })}
          options={[
            { value: '', label: `All branches (${branches.length})` },
            ...branches.map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
      </Toolbar>

      {!online && !report.data ? (
        <ErrorState
          title="No connection"
          body="Reports are read from the server and nothing is cached on this machine."
          onRetry={() => void report.refetch()}
        />
      ) : report.isLoading && !report.data ? (
        <div className="flex flex-col gap-px bg-line">
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </div>
      ) : report.error || !report.data ? (
        <ErrorState
          title="That report could not be read"
          // Never an empty report on a failed read: "no revenue this month" is
          // a far more damaging sentence than "this did not load".
          body={
            report.error instanceof OfflineError
              ? 'No connection. Nothing is shown rather than a report that might be wrong.'
              : report.error instanceof ApiError
                ? report.error.message
                : 'The server did not answer.'
          }
          onRetry={() => void report.refetch()}
          requestId={report.error instanceof ApiError ? report.error.requestId : undefined}
        />
      ) : tab === 'revenue' ? (
        <Revenue data={report.data as RevenueReport} timeZone={timeZone} />
      ) : tab === 'membership' ? (
        <Membership data={report.data as MembershipReport} timeZone={timeZone} />
      ) : tab === 'attendance' ? (
        <Attendance data={report.data as AttendanceReport} timeZone={timeZone} />
      ) : tab === 'trainer' ? (
        <Trainer data={report.data as TrainerReport} timeZone={timeZone} />
      ) : (
        <Retention data={report.data as RetentionReport} timeZone={timeZone} />
      )}

      {runExport.error ? (
        <p role="alert" className="border-t border-line bg-wash-chum px-3.5 py-2.5 text-[12px] text-foam-80">
          {runExport.error instanceof ApiError ? runExport.error.message : 'That export did not run.'}
        </p>
      ) : null}

      {exported ? (
        <Modal
          open
          onClose={() => setExported(null)}
          title="Export ready"
          kicker={`${exported.rows.toLocaleString('en-IN')} rows`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setExported(null)}>
                Close
              </Button>
              <Button
                variant="cta"
                onClick={() => {
                  // Built and revoked here rather than held on the page: the
                  // file is the whole filtered set and can be large.
                  const url = URL.createObjectURL(new Blob([exported.csv], { type: exported.contentType }));
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = exported.filename;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Save {exported.filename}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 p-4">
            <p className="text-[13px] leading-relaxed text-foam-80">
              {exported.rows.toLocaleString('en-IN')} rows for {from} to {to}. This is the complete filtered set, not
              the page on screen.
            </p>
            <p className="text-[11px] leading-relaxed text-foam-45">
              This export is recorded in the audit log with the filters that produced it.
            </p>
            <pre className="max-h-48 overflow-auto border border-line bg-hull p-2.5 font-utility text-[11px] leading-relaxed">
              {exported.csv.split('\n').slice(0, 8).join('\n')}
              {exported.csv.split('\n').length > 8 ? '\n…' : ''}
            </pre>
          </div>
        </Modal>
      ) : null}
    </Page>
  );
}
