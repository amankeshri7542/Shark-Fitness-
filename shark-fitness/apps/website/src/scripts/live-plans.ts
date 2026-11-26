import type { PublicSite } from '@shark/contracts';
import { getJson } from './api';

/**
 * Prices are printed at build time from the gym's catalogue. This refreshes
 * them from the live catalogue so a price change shows before the next
 * deploy, and withdraws a plan that is no longer published. If the API cannot
 * be reached the built prices stay, which is the point of building them in.
 */
export async function refreshPlans(): Promise<void> {
  const cards = document.querySelectorAll<HTMLElement>('[data-plan-id]');
  if (cards.length === 0) return;
  let site: PublicSite;
  try {
    site = await getJson<PublicSite>('/site');
  } catch {
    return;
  }
  const live = new Map(site.plans.map((plan) => [plan.id, plan]));
  for (const card of cards) {
    const plan = live.get(card.dataset.planId!);
    if (!plan) {
      card.hidden = true;
      continue;
    }
    const set = (field: string, text: string) => {
      const element = card.querySelector<HTMLElement>(`[data-field="${field}"]`);
      if (element && element.textContent !== text) element.textContent = text;
    };
    set('price', plan.priceLabel);
    set('cadence', plan.cadenceLabel);
  }
}
