import type { MembershipReport } from '@shark/contracts';
import { EmptyState, Panel, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { Cell, Delta, ReportContext, Strip, Trend, count, money, pct } from './shared';

/** Joins, leavers and what is left — the shape of the base, not its money. */
export default function Membership({ data, timeZone }: { data: MembershipReport; timeZone: string }) {
  const { meta } = data;
  return (
    <>
      <ReportContext meta={meta} timeZone={timeZone} />

      <Strip>
        <Cell label="Joins" value={count(data.joins.value)} unit="new memberships" delta={<Delta of={data.joins} />} />
        <Cell
          label="Cancellations"
          value={count(data.cancellations.value)}
          unit="left in range"
          delta={<Delta of={data.cancellations} invert />}
        />
        <Cell
          label="Net change"
          value={`${data.netChange > 0 ? '+' : ''}${count(data.netChange)}`}
          unit={`${count(data.activeAtEnd)} active now`}
        />
        <Cell
          label="Average value"
          value={money(data.ltvMinor)}
          unit="per membership"
          withheld={data.ltvMinor === null ? 'Needs report.financial.' : undefined}
        />
      </Strip>

      <Trend
        label="Joins by day"
        points={data.series.map((p) => ({ date: p.date, value: p.joins }))}
        format={(v) => count(v)}
      />

      <Panel title="By product">
        {data.byProduct.length === 0 ? (
          <EmptyState title="No products" body="No memberships exist for the branches in scope." />
        ) : (
          <TableScroll>
            <Table>
              <THead>
                <TH>Product</TH>
                <TH numeric>Joins in range</TH>
                <TH numeric>Cancelled</TH>
                <TH numeric>Active now</TH>
              </THead>
              <tbody>
                {data.byProduct.map((row) => (
                  <TR key={row.productId}>
                    <TD>{row.productName}</TD>
                    <TD numeric>{count(row.joins)}</TD>
                    <TD numeric>{count(row.cancellations)}</TD>
                    <TD numeric>{count(row.activeAtEnd)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Panel>

      <Panel title="Movement">
        <TableScroll>
          <Table>
            <THead>
              <TH>Measure</TH>
              <TH numeric>In range</TH>
              <TH numeric>Previous</TH>
            </THead>
            <tbody>
              <TR>
                <TD>Joins</TD>
                <TD numeric>{count(data.joins.value)}</TD>
                <TD numeric>{count(data.joins.previous)}</TD>
              </TR>
              <TR>
                <TD>Cancellations</TD>
                <TD numeric>{count(data.cancellations.value)}</TD>
                <TD numeric>{count(data.cancellations.previous)}</TD>
              </TR>
              <TR>
                <TD>Freezes</TD>
                <TD numeric>{count(data.freezes.value)}</TD>
                <TD numeric>{count(data.freezes.previous)}</TD>
              </TR>
              <TR>
                <TD>Renewals</TD>
                <TD numeric>{count(data.renewals.value)}</TD>
                <TD numeric>{count(data.renewals.previous)}</TD>
              </TR>
              <TR data-total="true">
                <TD>Churn</TD>
                <TD numeric>{pct(data.churnBp)}</TD>
                <TD numeric>—</TD>
              </TR>
            </tbody>
          </Table>
        </TableScroll>
        <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
          Churn is cancellations over the base that could have churned — active memberships plus the ones that left.
          It is absent, not zero, when that base is empty.
        </p>
      </Panel>
    </>
  );
}
