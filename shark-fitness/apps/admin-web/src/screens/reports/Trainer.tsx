import type { TrainerReport } from '@shark/contracts';
import { EmptyState, Panel, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { ReportContext, count, pct } from './shared';

/**
 * Coaches.
 *
 * No summary strip: an average across trainers is a number that describes
 * nobody, and the decision this screen supports is always about one of them.
 * The table is the report.
 */
export default function Trainer({ data, timeZone }: { data: TrainerReport; timeZone: string }) {
  return (
    <>
      <ReportContext meta={data.meta} timeZone={timeZone} />

      <Panel title="Utilisation and retention by coach">
        {data.rows.length === 0 ? (
          <EmptyState title="No coaches in range" body="No sessions were led and no members are assigned a coach." />
        ) : (
          <TableScroll>
            <Table>
              <THead>
                <TH>Coach</TH>
                <TH numeric>Sessions</TH>
                <TH numeric>Seats booked</TH>
                <TH numeric>Capacity</TH>
                <TH numeric>Utilisation</TH>
                <TH numeric>Attended</TH>
                <TH numeric>No-shows</TH>
                <TH numeric>Members</TH>
                <TH numeric>Still active</TH>
              </THead>
              <tbody>
                {data.rows.map((row) => (
                  <TR key={row.trainerId}>
                    <TD>{row.trainerName}</TD>
                    <TD numeric>{count(row.sessionsLed)}</TD>
                    <TD numeric>{count(row.seatsBooked)}</TD>
                    <TD numeric>{count(row.seatsCapacity)}</TD>
                    <TD numeric>{pct(row.utilisationBp)}</TD>
                    <TD numeric>{count(row.attended)}</TD>
                    <TD numeric>{count(row.noShows)}</TD>
                    <TD numeric>{count(row.membersCoached)}</TD>
                    <TD numeric>{pct(row.retentionBp)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
        <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
          Retention is the share of a coach’s assigned members still active, and the member count beside it is the base
          it is computed on — two members both still here is 100% and says very little.
        </p>
      </Panel>
    </>
  );
}
