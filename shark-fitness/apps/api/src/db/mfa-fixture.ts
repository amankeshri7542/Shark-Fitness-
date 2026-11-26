import { and, inArray, isNull } from 'drizzle-orm';
import { db, schema, sqlite } from './client.js';
import { MFA_MANDATORY_ROLES, enrolWithKnownSecret } from '../services/mfa.js';

/**
 * Enrols seeded staff in TOTP with a secret the caller already knows, so an
 * automated test can sign in as an owner by generating the code itself
 * (docs/SECURITY.md "Tests and the demo"). It writes to the database named by
 * SHARK_DB and nothing else; it is not reachable over HTTP.
 *
 *   tsx src/db/mfa-fixture.ts --secret <base32> --email owner@sharkfitness.in [--email …]
 *   tsx src/db/mfa-fixture.ts --secret <base32> --all-required
 *
 * `--all-required` enrols every account whose role always requires MFA.
 * Never run it against a database real people use: anyone holding the secret
 * passes the second factor for those accounts.
 */

export function enrolFixture(secret: string, target: { emails: string[] } | 'all-required'): string[] {
  const users =
    target === 'all-required'
      ? db.select().from(schema.users).where(and(inArray(schema.users.role, [...MFA_MANDATORY_ROLES]), isNull(schema.users.deletedAt))).all()
      : db.select().from(schema.users).where(and(inArray(schema.users.email, target.emails), isNull(schema.users.deletedAt))).all();
  for (const user of users) enrolWithKnownSecret(user, secret);
  return users.map((user) => user.email ?? user.id);
}

function argValues(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, index) => {
    if (arg === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  });
  return values;
}

if (process.argv[1]?.endsWith('mfa-fixture.ts')) {
  const secret = argValues('--secret')[0];
  const emails = argValues('--email');
  const all = process.argv.includes('--all-required');
  if (!secret || (!all && emails.length === 0)) {
    console.error('usage: mfa-fixture.ts --secret <base32> (--email <address>… | --all-required)');
    process.exit(2);
  }
  const enrolled = enrolFixture(secret, all ? 'all-required' : { emails });
  // Never print the secret.
  console.log(`mfa fixture: enrolled ${enrolled.length} account(s): ${enrolled.join(', ')}`);
  sqlite.close();
}
