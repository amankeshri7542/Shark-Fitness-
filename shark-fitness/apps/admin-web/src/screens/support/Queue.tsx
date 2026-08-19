import { useState } from 'react';
import type { TicketQueue as TicketQueueShape, TicketSummary } from '@shark/contracts';
import {
  Button,
  Chip,
  EmptyState,
  Label,
  Panel,
  RowOpen,
  Skeleton,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableScroll,
  Toolbar,
} from '../../ui/console';
import { CATEGORY_LABEL, PriorityChip, SlaChip, TicketStateChip, dateTime, since } from './shared';

/* ============================================================================
   The ticket queue (PF-SUP-001).

   The table is the screen. Everything that acts on a ticket happens in a
   drawer over it, so the queue a person is working down never goes away —
   support is a list you get to the bottom of, and paging away from it loses
   your place every time.

   The default order is the order the work has to happen in: breaches first,
   then urgency, then oldest. That sort lives on the server so every client and
   every count agrees with it.
   ========================================================================= */

type Flag = 'all' | 'mine' | 'unassigned' | 'breached' | 'escalated';

export default function Queue({
  data,
  loading,
  timeZone,
  online,
  canManage,
  flag,
  onFlag,
  search,
  onSearch,
  onOpen,
  onNew,
}: {
  data: TicketQueueShape | undefined;
  loading: boolean;
  timeZone: string;
  online: boolean;
  canManage: boolean;
  flag: Flag;
  onFlag: (value: Flag) => void;
  search: string;
  onSearch: (value: string) => void;
  onOpen: (ticketId: string) => void;
  onNew: () => void;
}) {
  const [category, setCategory] = useState('all');
  const [state, setState] = useState('all');

  const counts = data?.counts;
  const rows = (data?.items ?? []).filter((t) => {
    if (category !== 'all' && t.category !== category) return false;
    if (state === 'live' && (t.state === 'resolved' || t.state === 'closed')) return false;
    if (state !== 'all' && state !== 'live' && t.state !== state) return false;
    return true;
  });

  return (
    <>
      <Toolbar>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="sr-only">Search tickets</span>
          <input
            className="sf-field !min-h-9 !text-[13px]"
            placeholder="Reference, subject, member or who owns it"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">Category</span>
          <select
            className="min-h-9 border border-line bg-panel px-2 text-[12px] text-foam"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">All</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="font-utility text-[9px] uppercase tracking-[0.14em] text-foam-45">State</span>
          <select
            className="min-h-9 border border-line bg-panel px-2 text-[12px] text-foam"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="live">Still open</option>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="pending_staff">Waiting on us</option>
            <option value="pending_member">Waiting on member</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
        </label>

        {canManage ? (
          <Button variant="cta" disabled={!online} onClick={onNew}>
            {online ? 'New ticket' : 'Offline'}
          </Button>
        ) : null}
      </Toolbar>

      {/* — The counts that decide what gets worked next. Four numbers, not a
            wall of KPI cards: a breach, an unowned ticket, an escalation and
            your own list are the only things that change what you do now. — */}
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line md:grid-cols-4">
        <Count
          label="Breaching"
          value={counts?.breached}
          tone={counts && counts.breached > 0 ? 'bad' : 'plain'}
          active={flag === 'breached'}
          onClick={() => onFlag(flag === 'breached' ? 'all' : 'breached')}
        />
        <Count
          label="Unassigned"
          value={counts?.unassigned}
          tone={counts && counts.unassigned > 0 ? 'warn' : 'plain'}
          active={flag === 'unassigned'}
          onClick={() => onFlag(flag === 'unassigned' ? 'all' : 'unassigned')}
        />
        <Count
          label="Escalated"
          value={counts?.escalated}
          tone={counts && counts.escalated > 0 ? 'bad' : 'plain'}
          active={flag === 'escalated'}
          onClick={() => onFlag(flag === 'escalated' ? 'all' : 'escalated')}
        />
        <Count
          label="Mine"
          value={counts?.mine}
          tone="plain"
          active={flag === 'mine'}
          onClick={() => onFlag(flag === 'mine' ? 'all' : 'mine')}
        />
      </div>

      <Panel>
        {loading ? (
          <Skeleton className="m-4 h-64" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={(data?.items.length ?? 0) === 0 ? 'Nothing in the queue' : 'Nothing matches'}
            body={
              (data?.items.length ?? 0) === 0
                ? 'No tickets at this branch. Members raise them from the app, and you can open one here for a walk-in or a phone call.'
                : 'No ticket matches these filters. Clear the search, or switch the state filter back to All.'
            }
            action={
              canManage && online && (data?.items.length ?? 0) === 0 ? (
                <Button variant="cta" onClick={onNew}>
                  New ticket
                </Button>
              ) : null
            }
          />
        ) : (
          <TableScroll className="max-h-[calc(100vh-330px)]">
            <Table>
              <THead>
                <TH>Reference</TH>
                <TH>Subject</TH>
                <TH>Member</TH>
                <TH>Category</TH>
                <TH align="center">Priority</TH>
                <TH align="center">State</TH>
                <TH>Reply promise</TH>
                <TH>Owner</TH>
                <TH>Opened</TH>
              </THead>
              <tbody>
                {rows.map((ticket) => (
                  <Row key={ticket.id} ticket={ticket} timeZone={timeZone} onOpen={onOpen} />
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>
    </>
  );
}

function Row({
  ticket,
  timeZone,
  onOpen,
}: {
  ticket: TicketSummary;
  timeZone: string;
  onOpen: (ticketId: string) => void;
}) {
  return (
    <TR onClick={() => onOpen(ticket.id)}>
      <TD className="font-utility text-[11px] whitespace-nowrap">
        <RowOpen onClick={() => onOpen(ticket.id)}>{ticket.reference}</RowOpen>
        {ticket.escalated ? (
          <Chip tone="bad" className="ml-1.5">
            Escalated
          </Chip>
        ) : null}
      </TD>
      <TD>
        <div className="max-w-[34ch] truncate text-[13px]">{ticket.subject}</div>
        {ticket.reopenCount > 0 ? (
          <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-flare">
            Reopened {ticket.reopenCount}×
          </div>
        ) : null}
      </TD>
      <TD className="text-[12px] text-foam-65">
        {ticket.anonymous ? (
          // Anonymity is absence: there is no name recorded to withhold.
          <span className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">Anonymous</span>
        ) : (
          <>
            <span className={ticket.memberInactive ? 'text-foam-45 line-through' : undefined}>
              {ticket.memberName ?? 'No member'}
            </span>
            {ticket.memberInactive ? (
              <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-35">Record deleted</div>
            ) : null}
          </>
        )}
      </TD>
      <TD className="text-[12px] text-foam-65">{CATEGORY_LABEL[ticket.category] ?? ticket.category}</TD>
      <TD align="center">
        <PriorityChip priority={ticket.priority} />
      </TD>
      <TD align="center">
        <TicketStateChip state={ticket.state} />
      </TD>
      <TD>
        <SlaChip state={ticket.sla.state} label={ticket.sla.label} />
      </TD>
      <TD className="text-[12px] text-foam-65">
        {ticket.assigneeName ?? <span className="text-flare">Unassigned</span>}
      </TD>
      <TD className="whitespace-nowrap text-[12px] text-foam-65">
        {/* Relative for scanning; the exact branch-local stamp on hover, since
            "3d ago" is the wrong unit to argue a dispute in. */}
        <span title={dateTime(ticket.openedAt, timeZone)}>{since(ticket.openedAt)}</span>
      </TD>
    </TR>
  );
}

function Count({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number | undefined;
  tone: 'plain' | 'warn' | 'bad';
  active: boolean;
  onClick: () => void;
}) {
  const colour = tone === 'bad' ? 'text-chum' : tone === 'warn' ? 'text-flare' : 'text-foam';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex cursor-pointer flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors ${
        active ? 'bg-wash-sonar' : 'bg-panel hover:bg-wash-sonar-soft'
      }`}
    >
      <Label>{label}</Label>
      <span className={`font-display text-[22px] leading-none tabular-nums ${colour}`}>
        {value === undefined ? '—' : value}
      </span>
    </button>
  );
}
