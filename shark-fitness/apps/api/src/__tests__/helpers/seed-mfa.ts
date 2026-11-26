import { sqlite } from '../../db/client.js';
import { enrolFixture } from '../../db/mfa-fixture.js';
import { TEST_MFA_SECRET } from './mfa-secret.js';

/** Run by `pnpm test` after the seed: every always-MFA account gets the test secret. */
const enrolled = enrolFixture(TEST_MFA_SECRET, 'all-required');
console.log(`test mfa fixture: ${enrolled.length} account(s)`);
sqlite.close();
