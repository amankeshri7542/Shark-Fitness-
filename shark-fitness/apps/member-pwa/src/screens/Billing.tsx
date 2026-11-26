import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CreditAccount } from '@shark/contracts';
import { api, API_ORIGIN } from '../lib/api';
import { useCheckout } from '../lib/checkout';
import { ScreenBody, Stack } from '../ui/shell';
import { Button, Chip, Display, EmptyState, ErrorState, Label, Metric, Panel, Seam, SeamCell, SectionRule, Skeleton, type Tone } from '../ui/primitives';
import { CheckoutPanel } from './billing/CheckoutPanel';
import { PlanSheet } from './billing/PlanSheet';
import { CreditsPanel } from './billing/CreditsPanel';

interface BillingPayload {
  /** Absent or unavailable: no payment provider, members pay at reception. */
  onlinePayment?: { available: boolean; provider: string | null; testMode: boolean };
  credits?: CreditAccount;
  receipts?: Array<{ id: string; amountLabel: string; method: string; settledAt: string }>;
  outstandingMinor: number;
  outstandingLabel: string;
  membership: {
    id: string;
    productName: string;
    state: string;
    endsOn: string | null;
    autoRenew: boolean;
    priceLabel: string;
  } | null;
  invoices: Array<{
    id: string;
    number: string;
    state: string;
    issuedOn: string;
    dueOn: string;
    totalLabel: string;
    dueMinor: number;
    dueLabel: string;
    payable: boolean;
    /** "Tax invoice" when raised under a valid GSTIN, else "Invoice". */
    document?: { kind: 'gst_tax_invoice' | 'invoice'; title: string };
  }>;
}

const STATE_TONE: Record<string, Tone> = {
  open: 'accent',
  partially_paid: 'warn',
  paid: 'good',
  overdue: 'bad',
  void: 'neutral',
  partially_refunded: 'warn',
  refunded: 'neutral',
};

const MEMBERSHIP_TONE: Record<string, Tone> = {
  active: 'good',
  grace: 'warn',
  pending_payment: 'warn',
  frozen: 'neutral',
  expired: 'bad',
  suspended: 'bad',
};

function requestedPlanFromUrl(): string | null {
  const plan = new URLSearchParams(window.location.search).get('plan');
  return plan && /^[A-Za-z0-9_-]{1,64}$/.test(plan) ? plan : null;
}

export default function BillingScreen() {
  const checkout = useCheckout();
  // Arriving from the website with `?plan=<productId>` opens the plan sheet
  // with that plan chosen; the sheet still shows price, GST and terms first.
  // (router.tsx validates it; read here so the screen also works on its own.)
  const [requestedPlan] = useState(requestedPlanFromUrl);
  const [choosingPlan, setChoosingPlan] = useState(requestedPlan !== null);
  const closePlans = () => {
    setChoosingPlan(false);
    // Once dealt with, a reload should not open the sheet again.
    if (requestedPlan && window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<BillingPayload>('/member/billing'),
  });

  if (isLoading) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-28" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </Stack>
      </ScreenBody>
    );
  }

  if (error || !data) {
    return (
      <ScreenBody>
        <Stack>
          <ErrorState
            title="Could not load billing"
            body="The connection did not answer. Nothing has changed."
            onRetry={() => void refetch()}
          />
        </Stack>
      </ScreenBody>
    );
  }

  const outstanding = data.outstandingMinor;
  const online = data.onlinePayment?.available === true;
  const membershipState = data.membership?.state ?? null;
  const canChoosePlan = online && (membershipState === null || membershipState === 'expired' || membershipState === 'cancelled');

  return (
    <ScreenBody>
      <Stack>
        {checkout.state.phase !== 'idle' ? (
          <CheckoutPanel state={checkout.state} onRetry={(target) => void checkout.pay(target)} onClose={checkout.reset} />
        ) : null}

        <Panel tone={outstanding > 0 ? 'warn' : 'plain'}>
          <div className="p-4">
            <Label>Outstanding balance</Label>
            <div className="mt-1.5">
              <Metric value={data.outstandingLabel} size="lg" tone={outstanding > 0 ? 'warn' : 'good'} />
            </div>
            {data.onlinePayment?.testMode ? (
              <p className="mt-2.5 flex items-center gap-2 text-[12px] text-foam-65">
                <Chip tone="warn">Test mode</Chip>
                Online payments use Razorpay test mode. No real money moves.
              </p>
            ) : null}
          </div>
        </Panel>

        <SectionRule>Your plan</SectionRule>
        {data.membership ? (
          <Panel>
            <div className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between">
                <Display size="sm" as="h2">
                  {data.membership.productName}
                </Display>
                <Chip tone={MEMBERSHIP_TONE[data.membership.state] ?? 'neutral'}>{data.membership.state.replace(/_/g, ' ')}</Chip>
              </div>
              <div className="flex items-center justify-between text-[13px] text-foam-65">
                <span>{data.membership.priceLabel}</span>
                <span>{data.membership.endsOn ? `Term ends ${data.membership.endsOn}` : 'No fixed end date'}</span>
              </div>
              {data.membership.state === 'pending_payment' ? (
                <p className="text-[12px] leading-relaxed text-flare">
                  {online
                    ? 'This plan is not active yet. It starts as soon as its invoice below is paid, here or at reception.'
                    : 'This plan is not active yet. Pay at reception; it activates after staff record the full payment.'}
                </p>
              ) : null}
              <p className="text-[12px] text-foam-45">
                {online
                  ? 'Renew here once this term has ended, or at reception. Automatic renewal and collection are not available.'
                  : 'Renew at reception. Automatic renewal and collection are not available.'}
              </p>
              {canChoosePlan ? (
                <Button variant="cta" size="md" className="mt-1 self-start" disabled={checkout.busy} onClick={() => setChoosingPlan(true)}>
                  Renew
                </Button>
              ) : null}
            </div>
          </Panel>
        ) : (
          <EmptyState
            title="No plan yet"
            body={online ? 'Choose a plan and pay for it here, or speak with the front desk.' : 'Speak with the front desk to get started with a membership.'}
            action={canChoosePlan ? (
              <Button variant="cta" size="md" disabled={checkout.busy} onClick={() => setChoosingPlan(true)}>
                Choose a plan
              </Button>
            ) : undefined}
          />
        )}

        <SectionRule>Invoices</SectionRule>
        {data.invoices.length === 0 ? (
          <EmptyState title="Nothing billed yet" body="Invoices will appear here once you have a plan or make a purchase." />
        ) : (
          <Seam direction="col">
            {data.invoices.map((inv) => (
              <SeamCell key={inv.id}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-utility text-[10px] uppercase tracking-[0.1em] text-foam-45">{inv.number}</div>
                    <div className="mt-0.5 text-[13px]">
                      {inv.issuedOn} · due {inv.dueOn}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Chip tone={STATE_TONE[inv.state] ?? 'neutral'}>{inv.state.replace(/_/g, ' ')}</Chip>
                    <span className="font-display text-[14px]">{inv.totalLabel}</span>
                  </div>
                </div>
                {inv.payable && online ? (
                  <div className="mt-2.5 flex flex-wrap items-center gap-3">
                    <Button
                      variant="cta"
                      size="md"
                      disabled={checkout.busy}
                      aria-label={`Pay ${inv.dueLabel} now for invoice ${inv.number}`}
                      onClick={() => void checkout.pay({ kind: 'invoice', invoiceId: inv.id, label: `invoice ${inv.number}` })}
                    >
                      Pay {inv.dueLabel} now
                    </Button>
                    <span className="text-[12px] text-foam-65">or at reception</span>
                  </div>
                ) : inv.payable ? (
                  <p className="mt-2.5 text-[13px] text-foam-65">
                    Pay {inv.dueLabel} at reception. Online payment is unavailable.
                  </p>
                ) : null}
                <div className="mt-2.5 flex flex-wrap gap-4 text-[13px]">
                  <span className="text-foam-45">{inv.document?.title ?? 'Invoice'}</span>
                  <a className="underline" href={`${API_ORIGIN}/v1/member/billing/invoices/${inv.id}/tax-invoice`} download>Download</a>
                  <a className="underline" href={`${API_ORIGIN}/v1/member/billing/invoices/${inv.id}/tax-invoice?format=html`} target="_blank" rel="noreferrer">Print / PDF</a>
                </div>
              </SeamCell>
            ))}
          </Seam>
        )}
        {data.credits ? (
          <CreditsPanel credits={data.credits} online={online} busy={checkout.busy} pay={(target) => void checkout.pay(target)} />
        ) : null}
        {data.receipts?.length ? <>
          <SectionRule>Payment records</SectionRule>
          <Panel><div className="divide-y divide-line">{data.receipts.map((receipt) => <div key={receipt.id} className="space-y-2 p-4 text-[13px]">
            <p>{receipt.amountLabel} · {receipt.method} · {receipt.settledAt.slice(0, 10)}</p>
            <p className="break-all text-foam-45">{receipt.id}</p>
            <div className="flex flex-wrap gap-4"><a className="underline" href={`${API_ORIGIN}/v1/member/billing/payments/${receipt.id}/receipt`} download>Download record</a>
              <a className="underline" href={`${API_ORIGIN}/v1/member/billing/payments/${receipt.id}/receipt?format=html`} target="_blank" rel="noreferrer">Print / PDF</a></div>
          </div>)}</div></Panel>
        </> : null}
      </Stack>
      {choosingPlan ? (
        <PlanSheet
          preferredProductId={requestedPlan}
          onClose={closePlans}
          onConfirm={(plan) => {
            closePlans();
            void checkout.pay({ kind: 'plan', productId: plan.productId, label: plan.name });
          }}
        />
      ) : null}
    </ScreenBody>
  );
}
