import type { StoreReport } from '@shark/contracts';
import {
  EmptyState,
  Freshness,
  Label,
  Metric,
  Panel,
  Segmented,
  Skeleton,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableScroll,
  Toolbar,
} from '../../ui/console';
import { FinancialGate, Money, money } from './shared';

/* ============================================================================
   Store insights (PF-POS-006).

   Two kinds of number live here and the screen keeps them apart. Sales, units
   and what needs reordering are operating data — anyone who runs the shop needs
   them to do the job. Cost, margin and stock value are the gym's commercial
   position, and the server withholds them from a role without
   `report.financial` rather than sending a zero. When that happens this screen
   says so in the block where the figures would have been, because a permission
   denial must not look like an empty result.
   ========================================================================= */

export type Window = '7' | '30' | '90';

export default function Insights({
  report,
  loading,
  window,
  onWindow,
}: {
  report: StoreReport | undefined;
  loading: boolean;
  window: Window;
  onWindow: (value: Window) => void;
}) {
  if (loading || !report) {
    return (
      <>
        <Toolbar>
          <Label>Window</Label>
          <Segmented
            label="Reporting window"
            value={window}
            onChange={onWindow}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
          />
        </Toolbar>
        <Skeleton className="m-4 h-64" />
      </>
    );
  }

  const canSeeMargin = report.financial.canSeeMargin;

  return (
    <>
      <Toolbar>
        <Label>Window</Label>
        <Segmented
          label="Reporting window"
          value={window}
          onChange={onWindow}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
        <span className="flex-1" />
        <span className="font-utility text-[9px] uppercase tracking-[0.12em] text-foam-35">
          {report.scope.branches} branch{report.scope.branches === 1 ? '' : 'es'}
        </span>
        {/* Computed from the ledger on every request, so it really is live. */}
        <Freshness kind="realtime" asOf={report.asOf} />
      </Toolbar>

      {/* — Headline. Operating figures first; commercial ones only if allowed. — */}
      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-3 xl:grid-cols-6">
        <Cell label="Sales" value={String(report.sales.orders)} unit={`${report.sales.unitsSold} units`} />
        <Cell label="Takings" value={money(report.sales.revenueMinor)} unit={`${money(report.sales.taxMinor)} tax`} />
        <Cell label="Refunds" value={String(report.sales.returns)} unit={`${report.sales.voided} voided`} />
        <Cell
          label="Margin"
          value={report.margin === null ? null : money(report.margin.marginMinor)}
          unit={report.margin === null ? undefined : `${(report.margin.marginBp / 100).toFixed(1)}%`}
          tone={canSeeMargin ? 'accent' : 'default'}
        />
        <Cell
          label="Stock value"
          value={report.valuation === null ? null : money(report.valuation.valuationMinor)}
          unit={report.valuation === null ? undefined : `${report.valuation.skus} SKUs`}
        />
        <Cell
          label="Shrinkage"
          value={report.shrinkage.costMinor === null ? null : money(report.shrinkage.costMinor)}
          unit={`${report.shrinkage.units} units`}
          tone={report.shrinkage.units > 0 ? 'warn' : 'default'}
        />
      </div>

      <div className="grid gap-px bg-line lg:grid-cols-2">
        <Panel title={`Needs reordering · ${report.lowStock.length}`}>
          {report.lowStock.length === 0 ? (
            <EmptyState title="Nothing to reorder" body="Every active product is above its reorder point." />
          ) : (
            <TableScroll className="max-h-[340px]">
              <Table>
                <THead>
                  <TH>Item</TH>
                  <TH>SKU</TH>
                  <TH align="right">On hand</TH>
                  <TH align="right">Reorder at</TH>
                </THead>
                <tbody>
                  {report.lowStock.map((row) => (
                    <TR key={row.id}>
                      <TD>
                        <div className="max-w-[24ch] truncate">{row.name}</div>
                      </TD>
                      <TD className="font-utility text-[11px] text-foam-50">{row.sku}</TD>
                      <TD numeric className={row.onHand <= 0 ? 'text-chum' : 'text-flare'}>
                        {row.onHand}
                      </TD>
                      <TD numeric className="text-foam-45">
                        {row.reorderAt}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>

        <Panel title={`Top sellers · ${report.topProducts.length}`}>
          {report.topProducts.length === 0 ? (
            <EmptyState title="Nothing sold yet" body="Once the till takes its first sale, the best sellers land here." />
          ) : (
            <TableScroll className="max-h-[340px]">
              <Table>
                <THead>
                  <TH>Item</TH>
                  <TH align="right">Units</TH>
                  <TH align="right">Takings</TH>
                  <TH align="right">Margin</TH>
                </THead>
                <tbody>
                  {report.topProducts.map((row) => (
                    <TR key={row.productId}>
                      <TD>
                        <div className="max-w-[24ch] truncate">{row.name}</div>
                      </TD>
                      <TD numeric>{row.units}</TD>
                      <TD numeric>{money(row.revenueMinor)}</TD>
                      <TD numeric className="text-foam-65">
                        <Money minor={row.marginMinor} />
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          )}
        </Panel>
      </div>

      <Panel title="Margin">
        <FinancialGate financial={report.financial}>
          {report.margin ? (
            <dl className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
              <Cell label="Takings" value={money(report.margin.revenueMinor)} />
              <Cell label="Cost of goods" value={money(report.margin.costMinor)} />
              <Cell label="Gross margin" value={money(report.margin.marginMinor)} tone="accent" />
              <Cell label="Margin rate" value={`${(report.margin.marginBp / 100).toFixed(1)}%`} />
            </dl>
          ) : null}
        </FinancialGate>
        {report.margin ? (
          <p className="border-t border-line px-4 py-2.5 text-[12px] leading-relaxed text-foam-45">
            Margin uses the cost captured on each line when it sold, not the product's cost today —
            restating a supplier price does not rewrite last month's profit.
          </p>
        ) : null}
      </Panel>
    </>
  );
}

function Cell({
  label,
  value,
  unit,
  tone = 'default',
}: {
  label: string;
  value: string | null;
  unit?: string;
  tone?: 'default' | 'accent' | 'warn';
}) {
  return (
    <div className="bg-panel p-3">
      <Label>{label}</Label>
      <div className="mt-1">
        {value === null ? (
          // The money is withheld; the count beside it is operating data and
          // stays. A manager still has to reorder against four lost units even
          // when they may not know what those units cost.
          <span className="font-utility text-[11px] uppercase tracking-[0.12em] text-foam-35">
            Restricted
            {unit ? <span className="ml-1.5 normal-case text-foam-50">· {unit}</span> : null}
          </span>
        ) : (
          <Metric value={value} unit={unit} tone={tone} />
        )}
      </div>
    </div>
  );
}
