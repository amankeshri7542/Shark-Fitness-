import type { RetentionReport } from '@shark/contracts';
import { EmptyState, Panel, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { Cell, ReportContext, Strip, count, money, pct } from './shared';

/** Who is at risk now, and how each joining month has held up since. */
export default function Retention({ data, timeZone }: { data: RetentionReport; timeZone: string }) {
  const total = data.bands.high + data.bands.watch + data.bands.low;
  return (
    <>
      <ReportContext meta={data.meta} timeZone={timeZone} />

      <Strip>
        <Cell label="High risk" value={count(data.bands.high)} unit={`of ${count(total)} members`} />
        <Cell label="Watch" value={count(data.bands.watch)} unit="worth a look" />
        <Cell label="Low" value={count(data.bands.low)} unit="no signal" />
        <Cell
          label="Value at risk"
          value={money(data.atRiskValueMinor)}
          unit="active memberships held by high-risk members"
          withheld={data.atRiskValueMinor === null ? 'Needs report.financial.' : undefined}
        />
      </Strip>

      <Panel title="Cohorts by joining month">
        {data.cohorts.length === 0 ? (
          <EmptyState title="No cohorts" body="No members are recorded for the branches in scope." />
        ) : (
          <TableScroll className="max-h-[28rem]">
            <Table>
              <THead>
                <TH>Joined</TH>
                <TH numeric>Members</TH>
                <TH numeric>Still active</TH>
                <TH numeric>Retained</TH>
              </THead>
              <tbody>
                {data.cohorts.map((c) => (
                  <TR key={c.cohort}>
                    <TD>{c.cohort}</TD>
                    <TD numeric>{count(c.joined)}</TD>
                    <TD numeric>{count(c.stillActive)}</TD>
                    <TD numeric>{pct(c.retainedBp)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
        <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
          Cohorts are the month a member joined, and retention is how much of that month is still active today. Risk
          bands use the same thresholds as the member directory and Support, so one member is not high risk on one
          screen and watch on another.
        </p>
      </Panel>
    </>
  );
}
