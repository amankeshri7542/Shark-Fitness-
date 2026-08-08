import type { Config } from 'drizzle-kit';

export default {
  // Globbed rather than pointed at the barrel: drizzle-kit loads these through
  // CJS and cannot resolve the `.js` specifiers the barrel re-exports.
  schema: [
    './src/db/schema/core.ts',
    './src/db/schema/members.ts',
    './src/db/schema/operations.ts',
    './src/db/schema/training.ts',
    './src/db/schema/engagement.ts',
  ],
  out: '../../infrastructure/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: './data/shark.db' },
  strict: true,
} satisfies Config;
