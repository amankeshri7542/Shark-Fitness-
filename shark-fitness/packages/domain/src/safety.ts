/**
 * Safety rails — PF-NUTR-005, PF-AI-005, PF-SUP-005.
 *
 * These are deliberately conservative and deliberately dumb. They do not
 * diagnose anything. They route a human to the conversation and surface support
 * resources; nothing here ever auto-replies with advice.
 */

export type SafetyCategory = 'injury' | 'disordered_eating' | 'medical' | 'distress' | 'pregnancy';

export interface SafetySignal {
  category: SafetyCategory;
  matched: string;
  /** What the product does about it. Never "diagnose". */
  action: 'route_to_human' | 'block_automation' | 'show_resources';
  note: string;
}

const PATTERNS: Array<{ category: SafetyCategory; terms: RegExp; note: string }> = [
  {
    category: 'injury',
    terms: /\b(injur(y|ed|ies)|torn?|tear|sprain(ed)?|fracture|dislocat|herniat|impinge|sharp pain|can'?t (walk|lift|move))\b/i,
    note: 'Mentions an injury. Progression is paused and a coach is notified.',
  },
  {
    category: 'disordered_eating',
    terms: /\b(starv(e|ing)|purge|purging|binge|laxative|not eaten|skip(ping)? meals|hate my body|disgusting)\b/i,
    note: 'Mentions restriction or body distress. Routed to a human; no automated nutrition advice is sent.',
  },
  {
    category: 'medical',
    terms: /\b(chest pain|dizzy|fainted|black(ed)? out|palpitation|blood pressure|diabet|asthma attack|seizure)\b/i,
    note: 'Mentions a medical symptom. Routed to a human with a note to seek medical advice.',
  },
  {
    category: 'distress',
    terms: /\b(want to (die|disappear)|self.?harm|suicid|hopeless|can'?t go on)\b/i,
    note: 'Mentions distress. Support resources are shown and staff are alerted immediately.',
  },
  {
    category: 'pregnancy',
    terms: /\b(pregnan|expecting|first trimester|postpartum|post.?natal)\b/i,
    note: 'Mentions pregnancy. Automated progression is paused pending coach review.',
  },
];

const ACTION_FOR: Record<SafetyCategory, SafetySignal['action']> = {
  injury: 'block_automation',
  disordered_eating: 'route_to_human',
  medical: 'route_to_human',
  distress: 'show_resources',
  pregnancy: 'block_automation',
};

export function scanForSafety(text: string): SafetySignal[] {
  if (!text) return [];
  const out: SafetySignal[] = [];
  for (const p of PATTERNS) {
    const m = p.terms.exec(text);
    if (m) {
      out.push({
        category: p.category,
        matched: m[0],
        action: ACTION_FOR[p.category],
        note: p.note,
      });
    }
  }
  return out;
}

export function blocksAutomation(signals: SafetySignal[]): boolean {
  return signals.some((s) => s.action === 'block_automation' || s.action === 'show_resources');
}

/**
 * Calorie floors. A coach cannot set a target below these without an explicit
 * override, and the override is audited. Figures are conservative general
 * guidance, not a clinical standard, and the copy says so.
 */
export const KCAL_FLOOR = { female: 1200, male: 1500, unspecified: 1200 } as const;

export function nutritionSafety(args: {
  kcal: number | null;
  sex: 'female' | 'male' | 'unspecified';
  bodyweightKg: number | null;
  proteinG: number | null;
}): string | null {
  if (args.kcal === null) return null;
  const floor = KCAL_FLOOR[args.sex];
  if (args.kcal < floor) {
    return `This target is below ${floor} kcal, which is lower than general guidance supports without medical supervision. A coach must confirm it before it is applied.`;
  }
  if (args.bodyweightKg && args.proteinG && args.proteinG > args.bodyweightKg * 3) {
    return 'This protein target is unusually high for the bodyweight on file. Worth a second look.';
  }
  return null;
}

/**
 * Goal pacing. Flags a goal that needs an unsafe rate of change. Advisory —
 * a member may keep the goal, they just see the honest arithmetic.
 */
export function goalPaceWarning(args: {
  kind: 'lift' | 'bodyweight' | 'attendance' | 'habit' | 'measurement' | 'event';
  baseline: number;
  target: number;
  daysRemaining: number;
}): string | null {
  if (args.daysRemaining <= 0) return null;
  const weeks = args.daysRemaining / 7;
  const delta = args.target - args.baseline;

  if (args.kind === 'bodyweight') {
    const perWeek = Math.abs(delta) / weeks;
    // ~1% of bodyweight per week is the usual upper bound for either direction.
    const cap = Math.max(0.5, args.baseline * 0.01);
    if (perWeek > cap) {
      return `That is about ${perWeek.toFixed(1)} kg a week. Changes faster than roughly ${cap.toFixed(1)} kg a week are hard to hold on to. Consider moving the date out.`;
    }
  }

  if (args.kind === 'lift' && delta > 0) {
    const pctGain = delta / Math.max(1, args.baseline);
    if (pctGain / weeks > 0.02) {
      return `That is a fast rate of strength gain to plan for. It may happen, but the date is optimistic.`;
    }
  }

  return null;
}
