import type { AttendanceReport } from '@shark/contracts';
import { EmptyState, Panel, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { Cell, Delta, ReportContext, Strip, Trend, count, pct } from './shared';

/** Who came in, when, and which booked seats went unused. */
export default function Attendance({ data, timeZone }: { data: AttendanceReport; timeZone: string }) {
  const { meta } = data;
  const peakHour = data.byHour.reduce((best, h) => (h.visits > best.visits ? h : best), data.byHour[0] ?? { hour: 0, visits: 0 });

  return (
    <>
      <ReportContext meta={meta} timeZone={timeZone} />

      <Strip>
        <Cell label="Visits" value={count(data.visits.value)} unit="entries granted" delta={<Delta of={data.visits} />} />
        <Cell
          label="Unique members"
          value={count(data.uniqueMembers.value)}
          unit="distinct people"
          delta={<Delta of={data.uniqueMembers} />}
        />
        <Cell
          label="No-shows"
          value={count(data.noShows.value)}
          unit={data.noShowRateBp === null ? 'no bookings in range' : `${pct(data.noShowRateBp)} of booked seats`}
          delta={<Delta of={data.noShows} invert />}
        />
        <Cell
          label="Class occupancy"
          value={pct(data.occupancyBp)}
          unit={data.occupancyBp === null ? 'no capacity scheduled' : 'seats taken of seats offered'}
        />
      </Strip>

      <Trend
        label="Visits by day"
        points={data.series.map((p) => ({ date: p.date, value: p.visits }))}
        format={(v) => count(v)}
      />

      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
        <Panel title={`Busiest hours · ${meta.timeZone}`}>
          <Trend
            label={`Peak ${String(peakHour.hour).padStart(2, '0')}:00`}
            points={data.byHour.map((h) => ({ date: `${String(h.hour).padStart(2, '0')}:00`, value: h.visits }))}
            format={(v) => count(v)}
          />
          <TableScroll className="max-h-64">
            <Table>
              <THead>
                <TH>Hour</TH>
                <TH numeric>Visits</TH>
              </THead>
              <tbody>
                {data.byHour
                  .filter((h) => h.visits > 0)
                  .map((h) => (
                    <TR key={h.hour}>
                      <TD>{String(h.hour).padStart(2, '0')}:00</TD>
                      <TD numeric>{count(h.visits)}</TD>
                    </TR>
                  ))}
              </tbody>
            </Table>
          </TableScroll>
        </Panel>

        <Panel title="By branch">
          {data.byBranch.length === 0 ? (
            <EmptyState title="Nothing in range" body="No entries were recorded in this period." />
          ) : (
            <TableScroll>
              <Table>
                <THead>
                  <TH>Branch</TH>
                  <TH numeric>Visits</TH>
                  <TH numeric>Occupancy</TH>
                </THead>
                <tbody>
                  {data.byBranch.map((row) => (
                    <TR key={row.branchId}>
                      <TD>{row.branchName}</TD>
                      <TD numeric>{count(row.visits)}</TD>
                      <TD numeric>{pct(row.occupancyBp)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>
      </div>

      <Panel title="Day by day">
        <TableScroll className="max-h-96">
          <Table>
            <THead>
              <TH>Date</TH>
              <TH numeric>Visits</TH>
              <TH numeric>No-shows</TH>
            </THead>
            <tbody>
              {data.series.map((p) => (
                <TR key={p.date}>
                  <TD>{p.date}</TD>
                  <TD numeric>{count(p.visits)}</TD>
                  <TD numeric>{count(p.noShows)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      </Panel>

      <p className="px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
        A no-show is a booked seat the member did not take. A cancelled seat is not one — they told us. Hours are the
        branch’s, in {meta.timeZone}.
      </p>
    </>
  );
}
