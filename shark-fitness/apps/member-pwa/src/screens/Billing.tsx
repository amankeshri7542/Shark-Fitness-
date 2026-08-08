import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import { Button, Chip, Display, EmptyState, ErrorState, Label, Metric, Panel, Seam, SeamCell, SectionRule, Skeleton, type Tone } from '../ui/primitives';

interface BillingPayload {
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

export default function BillingScreen() {
  const queryClient = useQueryClient();
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['member-billing'],
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

  const outstanding = data.invoices.reduce((sum, i) => sum + Math.max(0, i.dueMinor), 0);

  return (
    <ScreenBody>
      <Stack>
        <Panel tone={outstanding > 0 ? 'warn' : 'plain'}>
          <div className="p-4">
            <Label>Outstanding balance</Label>
            <div className="mt-1.5">
              <Metric value={outstanding > 0 ? data.invoices.find((i) => i.dueMinor > 0)?.dueLabel ?? '—' : '₹0'} size="lg" tone={outstanding > 0 ? 'warn' : 'good'} />
            </div>
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
                <span>{data.membership.endsOn ? `Renews ${data.membership.endsOn}` : 'No fixed end date'}</span>
              </div>
              {data.membership.state === 'pending_payment' ? (
                <p className="text-[12px] leading-relaxed text-flare">
                  This plan is not active yet. Settle the invoice below to activate it.
                </p>
              ) : null}
              {!data.membership.autoRenew ? <p className="text-[12px] text-foam-45">Auto-renew is off — this plan will not continue automatically.</p> : null}
            </div>
          </Panel>
        ) : (
          <EmptyState title="No plan yet" body="Speak with the front desk to get started with a membership." />
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
                {inv.payable ? (
                  <Button variant="cta" full className="mt-2.5" onClick={() => setPayingInvoiceId(inv.id)}>
                    Pay {inv.dueLabel}
                  </Button>
                ) : null}
              </SeamCell>
            ))}
          </Seam>
        )}
      </Stack>

      {payingInvoiceId ? (
        <CheckoutSheet
          invoiceId={payingInvoiceId}
          onClose={() => setPayingInvoiceId(null)}
          onDone={() => {
            setPayingInvoiceId(null);
            void queryClient.invalidateQueries({ queryKey: ['member-billing'] });
            void queryClient.invalidateQueries({ queryKey: ['home'] });
          }}
        />
      ) : null}
    </ScreenBody>
  );
}

type Stage = 'confirming' | 'succeeded' | 'failed';

/** Demo checkout — there is no live payment gateway behind this. The screen
 *  says so honestly rather than performing a fake "processing…" spinner that
 *  implies a real card network is being contacted. */
function CheckoutSheet({ invoiceId, onClose, onDone }: { invoiceId: string; onClose: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<Stage>('confirming');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const intent = useMutation({
    mutationFn: () => api<{ intentId: string; amountMinor: number; clientToken: string }>('/member/billing/checkout-intent', { method: 'POST', body: { invoiceId } }),
    onError: (e) => {
      setStage('failed');
      setErrorMessage(e instanceof ApiError ? e.message : 'Could not start checkout.');
    },
    onSuccess: (data) => confirm.mutate(data.intentId),
  });

  const confirm = useMutation({
    mutationFn: (intentId: string) => api<{ invoiceState: string }>(`/member/billing/checkout-intent/${intentId}/confirm`, { method: 'POST' }),
    onSuccess: () => setStage('succeeded'),
    onError: (e) => {
      setStage('failed');
      setErrorMessage(e instanceof ApiError ? e.message : 'The payment could not be confirmed.');
    },
  });

  if (stage === 'confirming' && !intent.isPending && !intent.isSuccess && !intent.isError) {
    intent.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center" onClick={stage !== 'confirming' ? onClose : undefined} role="presentation">
      <div className="w-full max-w-[420px] border border-line-strong bg-overlay p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Checkout">
        <Display size="sm" as="h2">
          {stage === 'succeeded' ? 'Payment received' : stage === 'failed' ? 'Payment did not go through' : 'Confirming payment'}
        </Display>

        <p className="mt-3 text-[13px] leading-relaxed text-foam-65">
          {stage === 'confirming' ? 'This is a demo checkout — there is no live card network behind it. Confirming now.' : null}
          {stage === 'succeeded' ? 'Your invoice is settled. If this activated a plan, it is active now.' : null}
          {stage === 'failed' ? (errorMessage ?? 'Something went wrong. Nothing was charged.') : null}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          {stage === 'failed' ? (
            <Button
              variant="cta"
              onClick={() => {
                setStage('confirming');
                intent.reset();
                confirm.reset();
              }}
            >
              Try again
            </Button>
          ) : null}
          <Button variant={stage === 'succeeded' ? 'cta' : 'outline'} onClick={stage === 'succeeded' ? onDone : onClose}>
            {stage === 'succeeded' ? 'Done' : 'Close'}
          </Button>
        </div>
      </div>
    </div>
  );
}
