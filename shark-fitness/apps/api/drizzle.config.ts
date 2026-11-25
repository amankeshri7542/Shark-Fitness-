import type { Config } from 'drizzle-kit';

export default {
  // Listed rather than pointed at the barrel: drizzle-kit loads these through
  // CJS and cannot resolve the `.js` specifiers the barrel re-exports. Every
  // file src/db/schema/index.ts re-exports must be here, or the next generated
  // migration would drop its tables (src/__tests__/migration-metadata.test.ts).
  schema: [
    './src/db/schema/core.ts',
    './src/db/schema/members.ts',
    './src/db/schema/operations.ts',
    './src/db/schema/training.ts',
    './src/db/schema/engagement.ts',
    './src/db/schema/account-recovery.ts',
    './src/db/schema/payment-receipts.ts',
    './src/db/schema/invoice-tax-documents.ts',
    './src/db/schema/push.ts',
  ],
  out: '../../infrastructure/migrations',
  dialect: 'sqlite',
  // Only `drizzle-kit push/studio/introspect` open this. Point it at a scratch
  // copy with SHARK_DB; never at a database people use.
  dbCredentials: { url: process.env.SHARK_DB ?? './data/shark.db' },
  strict: true,
} satisfies Config;
