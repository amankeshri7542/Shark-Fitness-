import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ScreenBody, Stack } from '../ui/shell';
import { Chip, Display, EmptyState, ErrorState, Label, Metric, Panel, Seam, SeamCell, SectionRule, Skeleton, type Tone } from '../ui/primitives';

interface BillingPayload {
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

  return (
    <ScreenBody>
      <Stack>
        <Panel tone={outstanding > 0 ? 'warn' : 'plain'}>
          <div className="p-4">
            <Label>Outstanding balance</Label>
            <div className="mt-1.5">
              <Metric value={data.outstandingLabel} size="lg" tone={outstanding > 0 ? 'warn' : 'good'} />
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
                <span>{data.membership.endsOn ? `Term ends ${data.membership.endsOn}` : 'No fixed end date'}</span>
              </div>
              {data.membership.state === 'pending_payment' ? (
                <p className="text-[12px] leading-relaxed text-flare">
                  This plan is not active yet. Pay at reception; it activates after staff record the full payment.
                </p>
              ) : null}
              <p className="text-[12px] text-foam-45">Renew at reception. Automatic renewal and collection are not available.</p>
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
                  <p className="mt-2.5 text-[13px] text-foam-65">
                    Pay {inv.dueLabel} at reception. Online payment is unavailable.
                  </p>
                ) : null}
              </SeamCell>
            ))}
          </Seam>
        )}
      </Stack>
    </ScreenBody>
  );
}
