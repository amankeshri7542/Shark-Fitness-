/**
 * The findings.json contract (P10 → P11) and the severity-count check against
 * UX-AUDIT.md. Pure functions; the CLI is audit/validate-findings.mjs.
 */

export const SEVERITIES = ['blocker', 'major', 'minor', 'polish'];
export const APPS = { ADM: 'admin', MEM: 'member', WEB: 'website' };
export const EFFORTS = ['S', 'M', 'L'];
export const STATUSES = ['open', 'fixed', 'wontfix'];

const ID = /^UX-(ADM|MEM|WEB)-(\d{3})$/;
const WCAG = /^[1-4]\.\d{1,2}\.\d{1,2}$/;
const PRD = /PRD|UX-[AM]\d{2}|DESIGN\.md|PF-|§/;

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Returns a list of problems; empty when the file is valid.
 * `screenshotExists(path)` is optional: when given, cited screenshots must exist.
 */
export function validateFindings(findings, { screenshotExists } = {}) {
  const errors = [];
  if (!Array.isArray(findings)) return ['findings.json must be an array'];
  const seen = new Set();
  findings.forEach((f, i) => {
    const at = `#${i} ${f && f.id ? f.id : '(no id)'}`;
    if (!f || typeof f !== 'object') {
      errors.push(`${at}: not an object`);
      return;
    }
    const id = ID.exec(f.id ?? '');
    if (!id) errors.push(`${at}: id must look like UX-ADM-001, UX-MEM-001 or UX-WEB-001`);
    else if (f.app !== APPS[id[1]]) errors.push(`${at}: app "${f.app}" does not match the id prefix (${APPS[id[1]]})`);
    if (seen.has(f.id)) errors.push(`${at}: duplicate id`);
    seen.add(f.id);
    for (const key of ['route', 'screen', 'title', 'recommendation']) {
      if (!nonEmpty(f[key])) errors.push(`${at}: ${key} is required`);
    }
    if (typeof f.prdRef !== 'string') errors.push(`${at}: prdRef must be a string`);
    if (!Array.isArray(f.wcag) || f.wcag.some((c) => !WCAG.test(c))) errors.push(`${at}: wcag must be an array of success criteria like "1.4.3"`);
    const hasPrd = nonEmpty(f.prdRef) && PRD.test(f.prdRef);
    const hasWcag = Array.isArray(f.wcag) && f.wcag.length > 0;
    if (!hasPrd && !hasWcag) errors.push(`${at}: needs a PRD 03 reference (prdRef) or a WCAG criterion`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${at}: severity must be one of ${SEVERITIES.join('|')}`);
    if (!EFFORTS.includes(f.effort)) errors.push(`${at}: effort must be S, M or L`);
    if (!STATUSES.includes(f.status)) errors.push(`${at}: status must be one of ${STATUSES.join('|')}`);
    const ev = f.evidence;
    if (!ev || typeof ev !== 'object') errors.push(`${at}: evidence is required`);
    else {
      if (!nonEmpty(ev.screenshot)) errors.push(`${at}: evidence.screenshot is required`);
      else if (!/^phases\/P1\d-screens\/.+\.png$/.test(ev.screenshot)) errors.push(`${at}: evidence.screenshot must be a phases/P10-screens/….png path`);
      else if (screenshotExists && !screenshotExists(ev.screenshot)) errors.push(`${at}: evidence.screenshot ${ev.screenshot} does not exist`);
      if (!nonEmpty(ev.selector) && !nonEmpty(ev.measurement)) errors.push(`${at}: evidence needs a selector or a measurement`);
    }
  });
  return errors;
}

/** {blocker: {admin, member, website, total}, …, total: {…}} */
export function countFindings(findings) {
  const blank = () => ({ admin: 0, member: 0, website: 0, total: 0 });
  const counts = Object.fromEntries([...SEVERITIES, 'total'].map((s) => [s, blank()]));
  for (const f of findings) {
    if (!counts[f.severity] || !(f.app in counts.total)) continue;
    counts[f.severity][f.app] += 1;
    counts[f.severity].total += 1;
    counts.total[f.app] += 1;
    counts.total.total += 1;
  }
  return counts;
}

/**
 * Reads the severity table UX-AUDIT.md keeps between
 * `<!-- severity-counts:start -->` and `<!-- severity-counts:end -->`:
 * | Severity | Admin | Member | Website | Total |
 */
export function parseReportCounts(markdown) {
  const match = /<!-- severity-counts:start -->([\s\S]*?)<!-- severity-counts:end -->/.exec(markdown);
  if (!match) return null;
  const counts = {};
  for (const line of match[1].split('\n')) {
    const cells = line.split('|').map((c) => c.replace(/\*/g, '').trim()).filter((c, i, all) => i > 0 && i < all.length - 1);
    if (cells.length !== 5) continue;
    const key = cells[0].toLowerCase();
    if (![...SEVERITIES, 'total'].includes(key)) continue;
    const [admin, member, website, total] = cells.slice(1).map(Number);
    counts[key] = { admin, member, website, total };
  }
  return counts;
}

/** Differences between the counts in the JSON and the report's table. */
export function compareCounts(actual, reported) {
  if (!reported) return ['UX-AUDIT.md has no severity-counts table (<!-- severity-counts:start --> … end)'];
  const problems = [];
  for (const severity of [...SEVERITIES, 'total']) {
    for (const app of ['admin', 'member', 'website', 'total']) {
      const want = actual[severity][app];
      const got = reported[severity]?.[app];
      if (got !== want) problems.push(`UX-AUDIT.md says ${severity}/${app} = ${got ?? 'missing'}, findings.json has ${want}`);
    }
  }
  return problems;
}

export function formatCounts(counts) {
  const rows = ['| Severity | Admin | Member | Website | Total |', '|---|---:|---:|---:|---:|'];
  for (const severity of [...SEVERITIES, 'total']) {
    const c = counts[severity];
    const label = severity === 'total' ? '**Total**' : severity[0].toUpperCase() + severity.slice(1);
    rows.push(`| ${label} | ${c.admin} | ${c.member} | ${c.website} | ${c.total} |`);
  }
  return rows.join('\n');
}
