export interface CreditLotView {
  lotId: string; packId: string | null; source: string; granted: number; used: number; revoked: number;
  remaining: number; usable: number; expiresOn: string | null; expired: boolean; grantedAt: string;
}

export interface CreditPackView {
  id: string; productId: string; productName: string; kind: 'class' | 'pt'; units: number; state: string;
  priceMinor: number; priceLabel: string; invoiceId: string; invoiceNumber: string; invoiceState: string; dueMinor: number;
  soldBy: string; createdAt: string; allocatedAt: string | null; expiresOn: string | null;
  remaining: number; used: number; expired: boolean;
  refund: { refundable: boolean; kind: 'full' | 'partial' | null; units: number; amountMinor: number; amountLabel: string; message: string };
}

export interface CreditPackOffer {
  productId: string; name: string; description: string; kind: 'class' | 'pt'; units: number; validDays: number;
  totalMinor: number; totalLabel: string; perCreditLabel: string;
}

export interface CreditAccount {
  today: string;
  balances: Array<{
    kind: 'class' | 'pt'; signedBalance: number; usableUnits: number | null; ledgerUnits: number;
    consumptionAvailable: boolean; warning: string | null;
    /** P05: the soonest-expiring usable credits, and every lot. */
    nextExpiry?: { units: number; on: string } | null;
    lots?: CreditLotView[];
  }>;
  entries: Array<{
    id: string; kind: string; delta: number; reason: string; refType: string | null; refId: string | null;
    expiresOn: string | null; expired: boolean; createdAt: string;
  }>;
  /** P05: packs bought, with what a refund would return today. */
  packs?: CreditPackView[];
  /** P05: packs on sale to this member. */
  offers?: CreditPackOffer[];
  saleAvailable: boolean;
  saleUnavailableReason: string;
  historyNotice: string;
}
