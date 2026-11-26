/**
 * Query keys shared by more than one screen. Two screens reading the same
 * endpoint under different keys used to mean a mutation on one left the other
 * stale (Train used ['plan'], Workout ['training', 'plan'], Exercise
 * invalidated ['train'], which matched nothing).
 */
export const QK = {
  home: ['home'],
  plan: ['training', 'plan'],
  schedule: ['schedule'],
  consents: ['consents'],
  notifications: ['notifications'],
} as const;
