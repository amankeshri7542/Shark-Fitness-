import type { RevenueReport } from '@shark/contracts';
import { Chip, EmptyState, Panel, PermissionState, Table, TableScroll, TD, TH, THead, TR } from '../../ui/console';
import { Cell, Delta, ReportContext, Strip, Trend, count, money } from './shared';

/**
 * Revenue.
 *
 * Money end to end, so the whole surface is behind `report.financial`. A role
 * without it gets a permission state rather than a page of zeroes — see the
 * service note; a zero here renders as a real figure.
 */
export default function Revenue({ data, timeZone }: { data: RevenueReport; timeZone: string }) {
  const { meta, totals } = data;

  if (!meta.canSeeFinancial) {
    return (
      <>
        <ReportContext meta={meta} timeZone={timeZone} />
        <PermissionState what="Revenue figures" />
      </>
    );
  }

  const currency = data.seriesCurrency ?? 'INR';

  return (
    <>
      <ReportContext meta={meta} timeZone={timeZone} />

      {data.mixedCurrency ? (
        <p className="border-b border-line bg-wash-flare px-3.5 py-2.5 text-[12px] leading-relaxed text-foam-80">
          This range spans {data.byCurrency.length} currencies, so there is no single total to state. Each is reported
          separately below; the trend is shown in {currency}.
        </p>
      ) : null}

      {totals ? (
        <Strip>
          <Cell
            label="Net revenue"
            value={money(totals.netMinor.value, currency)}
            unit="after refunds"
            delta={<Delta of={totals.netMinor} />}
          />
          <Cell
            label="Gross"
            value={money(totals.grossMinor.value, currency)}
            unit={`${count(totals.invoices.value)} invoices`}
            delta={<Delta of={totals.grossMinor} />}
          />
          <Cell label="Refunded" value={money(totals.refundedMinor, currency)} unit="returned to members" />
          <Cell
            label="Per paying member"
            value={money(totals.arpuMinor, currency)}
            unit={totals.arpuMinor === null ? 'nobody paid in range' : 'average'}
          />
        </Strip>
      ) : (
        <Strip>
          {data.byCurrency.map((c) => (
            <Cell key={c.currency} label={`Net · ${c.currency}`} value={money(c.netMinor, c.currency)} unit={`${count(c.invoices)} invoices`} />
          ))}
        </Strip>
      )}

      <Trend
        label={`Net revenue by day · ${currency}`}
        points={data.series.map((p) => ({ date: p.date, value: p.netMinor }))}
        format={(v) => money(v, currency)}
      />

      <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-2">
        <Panel title="By branch">
          {data.byBranch.length === 0 ? (
            <EmptyState title="Nothing in range" body="No invoices were raised in this period." />
          ) : (
            <TableScroll>
              <Table label="Revenue by branch">
                <THead>
                  <TH>Branch</TH>
                  <TH numeric>Invoices</TH>
                  <TH numeric>Net</TH>
                </THead>
                <tbody>
                  {data.byBranch.map((row) => (
                    <TR key={row.branchId}>
                      <TD>{row.branchName}</TD>
                      <TD numeric>{count(row.invoices)}</TD>
                      <TD numeric>{money(row.netMinor, currency)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>

        <Panel title="By payment method">
          {data.byMethod.length === 0 ? (
            <EmptyState title="No payments" body="Nothing was taken in this period." />
          ) : (
            <TableScroll>
              <Table label="Revenue by payment method">
                <THead>
                  <TH>Method</TH>
                  <TH numeric>Payments</TH>
                  <TH numeric>Amount</TH>
                </THead>
                <tbody>
                  {data.byMethod.map((row) => (
                    <TR key={row.method}>
                      <TD className="capitalize">{row.method.replace(/_/g, ' ')}</TD>
                      <TD numeric>{count(row.payments)}</TD>
                      <TD numeric>{money(row.amountMinor, currency)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>
      </div>

      {/* "What sold", not "By product": only some of these rows are catalogue
          products. A membership sale carries a product id and is a real
          product; a shop basket posts as one free-text line and has no
          identity beyond its own description. Labelling both as products
          would put a figure under a heading the catalogue cannot reconcile. */}
      <Panel title="What sold">
        {data.byProduct.length === 0 ? (
          <EmptyState title="Nothing sold" body="No invoice lines fall in this period." />
        ) : (
          <>
            <TableScroll>
              <Table label="What sold">
                <THead>
                  <TH>Item</TH>
                  <TH numeric>Units</TH>
                  <TH numeric>Net</TH>
                </THead>
                <tbody>
                  {data.byProduct.map((row) => (
                    <TR key={row.productId ?? `line:${row.productName}`}>
                      <TD>
                        <span className="flex flex-wrap items-center gap-2">
                          {row.productName}
                          {row.identified ? null : <Chip tone="neutral">Not itemised</Chip>}
                        </span>
                      </TD>
                      <TD numeric>{count(row.units)}</TD>
                      <TD numeric>{money(row.netMinor, currency)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
            {data.byProduct.some((row) => !row.identified) ? (
              <p className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
                A row marked <em className="not-italic text-foam-65">Not itemised</em> is grouped by what the invoice
                line says, because it names no catalogue product. Shop baskets post as a single line; the Store report
                breaks those down by item.
              </p>
            ) : null}
          </>
        )}
      </Panel>

      {data.byCurrency.length > 0 ? (
        <Panel title="By currency">
          <TableScroll>
            <Table label="Revenue by currency">
              <THead>
                <TH>Currency</TH>
                <TH numeric>Invoices</TH>
                <TH numeric>Gross</TH>
                <TH numeric>Refunded</TH>
                <TH numeric>Tax</TH>
                <TH numeric>Net</TH>
              </THead>
              <tbody>
                {data.byCurrency.map((row) => (
                  <TR key={row.currency}>
                    <TD>{row.currency}</TD>
                    <TD numeric>{count(row.invoices)}</TD>
                    <TD numeric>{money(row.grossMinor, row.currency)}</TD>
                    <TD numeric>{money(row.refundedMinor, row.currency)}</TD>
                    <TD numeric>{money(row.taxMinor, row.currency)}</TD>
                    <TD numeric>{money(row.netMinor, row.currency)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Panel>
      ) : null}

      <p className="px-3.5 py-2.5 text-[11px] leading-relaxed text-foam-45">
        Net is gross less refunds. Voided invoices are excluded rather than netted. Days are the branch’s, in{' '}
        {meta.timeZone}.
      </p>
    </>
  );
}
