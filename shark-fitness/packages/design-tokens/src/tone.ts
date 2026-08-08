/**
 * Voice.
 *
 * The prototype ships a `predatorCopy` toggle. It is a real member preference
 * here, on by default as the prototype has it.
 *
 * It is bounded on purpose. Predator copy is confined to the training floor —
 * home, workout, progress, challenges. Payment, access denial, injury, support,
 * privacy and every destructive confirmation always use the plain register,
 * because the product PRD forbids shame, fear and manufactured urgency and a
 * declined payment is not a moment for a hunting metaphor.
 *
 * Enforcement: only strings in PREDATOR_COPY have a hard variant. Anything a
 * safety- or money-critical surface renders is a plain constant, so a caller
 * cannot accidentally reach for the aggressive register there.
 */

export type Register = 'predator' | 'plain';

/** Keys that carry a predator variant. Everything else is plain, always. */
export const PREDATOR_COPY = {
  navHome: { predator: 'Hunt', plain: 'Today' },
  navTrain: { predator: 'Strike', plain: 'Train' },
  navProgress: { predator: 'Depth', plain: 'Progress' },
  navPack: { predator: 'Pack', plain: 'Community' },

  homeKicker: { predator: 'Depth 3 · apex zone', plain: 'Your day' },
  homeHeroA: { predator: 'Keep', plain: 'Session' },
  homeHeroB: { predator: 'moving', plain: 'ready' },
  startSession: { predator: 'Strike now', plain: 'Start session' },
  resumeSession: { predator: 'Back in', plain: 'Resume session' },
  finishSession: { predator: 'Log the strike', plain: 'Finish session' },
  streakLabel: { predator: 'Day hunt streak', plain: 'Day streak' },

  passTitle: { predator: 'Enter the water', plain: 'Gym pass' },
  checkIn: { predator: 'Dive in · check in', plain: 'Check in' },
  checkOut: { predator: 'Surface · check out', plain: 'Check out' },

  progressTitle: { predator: 'Deeper every week', plain: 'Your progress' },
  prTitle: { predator: 'Personal records · bite force', plain: 'Personal records' },
  packTitle: { predator: 'Swim with the pack', plain: 'Community' },
  challengeTitle: { predator: 'Deep water challenge', plain: 'Monthly challenge' },
} as const;

export type CopyKey = keyof typeof PREDATOR_COPY;

export function tone(register: Register) {
  return (key: CopyKey): string => PREDATOR_COPY[key][register];
}

/**
 * Surfaces where the predator register is never used, whatever the preference.
 * Kept as a list so the rule is greppable and testable rather than folklore.
 */
export const PLAIN_ONLY_SURFACES = [
  'billing',
  'payment',
  'access-denied',
  'membership-issue',
  'injury',
  'support',
  'privacy',
  'account-deletion',
  'consent',
  'safety',
] as const;

export type PlainOnlySurface = (typeof PLAIN_ONLY_SURFACES)[number];

export function registerFor(
  preference: Register,
  surface?: string,
): Register {
  if (surface && (PLAIN_ONLY_SURFACES as readonly string[]).includes(surface)) return 'plain';
  return preference;
}
