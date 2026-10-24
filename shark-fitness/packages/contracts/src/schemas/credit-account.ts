export interface CreditAccount {
  today: string;
  balances: Array<{
    kind: 'class' | 'pt'; signedBalance: number; usableUnits: number | null; ledgerUnits: number;
    consumptionAvailable: boolean; warning: string | null;
  }>;
  entries: Array<{
    id: string; kind: string; delta: number; reason: string; refType: string | null; refId: string | null;
    expiresOn: string | null; expired: boolean; createdAt: string;
  }>;
  saleAvailable: boolean;
  saleUnavailableReason: string;
  historyNotice: string;
}
