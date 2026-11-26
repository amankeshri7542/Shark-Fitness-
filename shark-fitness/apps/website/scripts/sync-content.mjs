#!/usr/bin/env node
// Refreshes src/content/snapshot.json from a running Shark Fitness API.
//
//   pnpm -F @shark/website sync-content -- --api http://localhost:8787 [--tenant shark]
//
// The website builds from this file, so a build never needs the API. Plans,
// branches and the weekly timetable come from the public endpoints only
// (/v1/public/:tenant/site and /classes) — exactly what any visitor can read.
// Dated classes are folded into a weekly pattern (weekday + time), because a
// static page outlives the fortnight the API answers for; the live page then
// fetches real dates and availability on top.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const api = option('api', process.env.SHARK_API_URL);
const tenant = option('tenant', process.env.SHARK_SITE_TENANT ?? 'shark');
if (!api) {
  console.error('Usage: pnpm -F @shark/website sync-content -- --api <url> [--tenant <slug>]');
  process.exit(2);
}

async function get(path) {
  const url = new URL(path, api);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const site = await get(`/v1/public/${encodeURIComponent(tenant)}/site`);
const timetable = {};
for (const branch of site.branches) {
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const classes = await get(`/v1/public/${encodeURIComponent(tenant)}/classes?branchId=${encodeURIComponent(branch.id)}&from=${today}&to=${until}`);
  const slots = new Map();
  for (const item of classes.items) {
    const day = DAYS[new Date(`${item.date}T12:00:00Z`).getUTCDay()];
    const key = `${day} ${item.startTime} ${item.name}`;
    if (!slots.has(key)) {
      slots.set(key, {
        day,
        startTime: item.startTime,
        endTime: item.endTime,
        name: item.name,
        category: item.category,
        level: item.level,
        coach: item.coach,
        durationMin: item.durationMin,
      });
    }
  }
  timetable[branch.id] = [...slots.values()].sort(
    (a, b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day) || a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name),
  );
}

const snapshot = { tenantSlug: tenant, syncedAt: new Date().toISOString(), site, timetable };
const target = resolve(import.meta.dirname, '../src/content/snapshot.json');
writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `sync-content: wrote ${target} — ${site.branches.length} branches, ${site.plans.length} plans, ` +
    `${Object.values(timetable).reduce((n, list) => n + list.length, 0)} weekly class slots`,
);
