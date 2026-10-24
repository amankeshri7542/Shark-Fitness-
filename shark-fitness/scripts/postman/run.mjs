/* ============================================================================
   Generates the collection for --base-url, runs it with the Postman CLI and
   prints what came back: how many requests answered, the statuses, every
   server error and every failed check. Exits 1 if anything failed.

   usage: node scripts/postman/run.mjs --base-url <url> [--read-only]
   ========================================================================= */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, parseOptions } from './generate.mjs';

let options;
try {
  options = parseOptions(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { collection, collectionPath, envPath, outDir } = await generate(options);
const names = {};
for (const folder of collection.item) for (const item of folder.item) names[item.id] = `${folder.name} / ${item.name}`;
const total = Object.keys(names).length;

const logPath = join(outDir, 'run.log');
const log = createWriteStream(logPath);
console.log(`Running ${total} requests with the Postman CLI; the full output goes to ${logPath}`);
const child = spawn(
  'postman',
  ['collection', 'run', collectionPath, '-e', envPath, '--delay-request', '25', '--no-report-events', '--disable-unicode'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let answered = 0;
const count = (chunk) => {
  log.write(chunk);
  const before = Math.floor(answered / 100);
  answered += (chunk.toString().match(/R\|r\d{4}\|/g) ?? []).length;
  if (Math.floor(answered / 100) > before) console.log(`  ${answered} of ${total}`);
};
child.stdout.on('data', count);
child.stderr.on('data', count);
const exitCode = await new Promise((done) => {
  child.on('error', (error) => {
    console.error(error.code === 'ENOENT' ? 'The Postman CLI is not installed: https://learning.postman.com/docs/postman-cli/postman-cli-installation/' : error.message);
    done(1);
  });
  child.on('close', done);
});
await new Promise((done) => log.end(done));

const output = readFileSync(logPath, 'utf8');
const codes = new Map([...output.matchAll(/R\|(r\d{4})\|(\d{3})/g)].map((m) => [m[1], Number(m[2])]));
const statuses = {};
for (const code of codes.values()) statuses[code] = (statuses[code] ?? 0) + 1;
const serverErrors = [...codes].filter(([, code]) => code >= 500);
const failed = [...new Set([...output.matchAll(/inside "([^"]+)"/g)].map((m) => m[1]))];
const skipped = new Set([...output.matchAll(/S\|(r\d{4})/g)].map((m) => m[1]));
const unanswered = Object.keys(names).filter((id) => !codes.has(id) && !skipped.has(id));

console.log(`\nAnswered: ${codes.size} of ${total}`);
console.log(`Statuses: ${Object.entries(statuses).map(([code, n]) => `${code}×${n}`).join(', ')}`);
if (skipped.size) console.log(`Skipped: ${skipped.size} (the branch is closed at this hour, so there is no visit to repeat or close)`);
console.log(`Server errors (5xx): ${serverErrors.length}`);
for (const [id, code] of serverErrors) console.log(`  ${code} ${names[id]}`);
console.log(`Failed checks: ${failed.length}`);
for (const name of failed) console.log(`  ${name}`);
if (unanswered.length) console.log(`No answer: ${unanswered.length}, first: ${unanswered.slice(0, 5).map((id) => names[id]).join('; ')}`);
if (failed.length) console.log(`Each failure's detail is in ${logPath}.`);
process.exitCode = exitCode !== 0 || serverErrors.length || failed.length || unanswered.length ? 1 : 0;
