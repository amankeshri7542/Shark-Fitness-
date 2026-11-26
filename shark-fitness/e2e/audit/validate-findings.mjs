// Validates docs/ux-audit/findings.json and checks its severity counts against
// the table in UX-AUDIT.md. Prints the counts; exits 1 on any problem.
//   node e2e/audit/validate-findings.mjs docs/ux-audit/findings.json [path/to/UX-AUDIT.md]
// (paths relative to the current directory; the report defaults to the JSON's sibling UX-AUDIT.md)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { SCREENS_DIR } from './lib/paths.mjs';
import { compareCounts, countFindings, formatCounts, parseReportCounts, validateFindings } from './lib/findings.mjs';

const [jsonArg, reportArg] = process.argv.slice(2);
if (!jsonArg) {
  console.error('usage: node e2e/audit/validate-findings.mjs <findings.json> [UX-AUDIT.md]');
  process.exit(2);
}
const jsonPath = resolve(jsonArg);
const reportPath = resolve(reportArg ?? resolve(dirname(jsonPath), 'UX-AUDIT.md'));
const findings = JSON.parse(readFileSync(jsonPath, 'utf8'));

// Screenshots are not committed. When this machine has them, every cited one must exist.
const screensRoot = dirname(dirname(SCREENS_DIR)); // …/shark-fitness-orchestration
const screenshotExists = existsSync(SCREENS_DIR) ? (cited) => existsSync(resolve(screensRoot, cited)) : undefined;

const errors = validateFindings(findings, { screenshotExists });
const counts = countFindings(Array.isArray(findings) ? findings : []);
errors.push(...compareCounts(counts, existsSync(reportPath) ? parseReportCounts(readFileSync(reportPath, 'utf8')) : null));

console.log(`${Array.isArray(findings) ? findings.length : 0} findings in ${jsonArg}${screenshotExists ? '' : ' (screenshots not on this machine: existence not checked)'}`);
console.log(formatCounts(counts));
if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log('\nSchema valid; counts match UX-AUDIT.md.');
