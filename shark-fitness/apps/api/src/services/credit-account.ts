import type { schema } from '../db/client.js';
import { creditAccount } from './credit-packs.js';

/** A member's credits: balances by lot, packs (with their refund quote), what
 *  is on sale, and the full ledger. See services/credit-packs.ts. */
export function readCreditAccount(member: typeof schema.members.$inferSelect) {
  return creditAccount(member);
}
