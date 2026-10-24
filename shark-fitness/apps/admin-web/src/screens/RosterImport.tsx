import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RosterFields, type RosterField, type RosterPreview, type RosterRowResult } from '@shark/contracts';
import { api, ApiError } from '../lib/api';
import { useAdmin, usePermission } from '../lib/store';
import { Button, Panel, SelectField, Field } from '../ui/console';

/** Quote every CSV cell and neutralize spreadsheet formulas, including whitespace prefixes. */
export function csvReportCell(value: string | number): string {
  const text = String(value);
  const first = [...text].find((char) => char.charCodeAt(0) >= 32 && !/\s/.test(char));
  const safe = (first && '=+@-'.includes(first)) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
interface Result { importId: string; rows: RosterRowResult[]; imported: number; skipped: number; rejected: number }
export function RosterImport() {
  const allowed = usePermission('member.edit');
  const branches = useAdmin((s) => s.branches) ?? [];
  const selectedBranch = useAdmin((s) => s.activeBranchId);
  const fileRead = useRef(0);
  const [open, setOpen] = useState(false); const [csv, setCsv] = useState('');
  const [branchId, setBranchId] = useState(selectedBranch ?? branches[0]?.id ?? '');
  const [mapping, setMapping] = useState<Partial<Record<RosterField, string>>>({});
  const [preview, setPreview] = useState<RosterPreview | null>(null); const [result, setResult] = useState<Result | null>(null);
  const [confirmed, setConfirmed] = useState(false); const [attempt, setAttempt] = useState(''); const [fileError, setFileError] = useState('');
  const client = useQueryClient();
  const invalidate = () => { setPreview(null); setResult(null); setConfirmed(false); setAttempt(''); };
  const previewCall = useMutation({ mutationFn: () => api<RosterPreview>('/admin/members/imports/preview', { method: 'POST', body: { branchId, csv, mapping } }), onSuccess: (value) => { setPreview(value); setConfirmed(false); setAttempt(crypto.randomUUID()); } });
  const commit = useMutation({ mutationFn: () => api<Result>('/admin/members/imports/commit', { method: 'POST', idempotencyKey: attempt, body: { branchId, csv, mapping, previewToken: preview!.previewToken, confirmed } }),
    onSuccess: (value) => { setResult(value); void client.invalidateQueries({ queryKey: ['members'] }); } });
  if (!allowed) return null;
  const rows = result?.rows ?? preview?.rows;
  const error = commit.error ?? previewCall.error;
  return <Panel className="p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="mb-2 font-heading text-lg text-foam">Roster import</h2><Button variant="outline" onClick={() => setOpen(!open)}>{open ? 'Close roster import' : 'Import contacts'}</Button></div>
    {open ? <div className="flex flex-col gap-3">
      <p className="text-sm text-foam-65">Up to 200 contacts / 256 KB. This creates invited accounts only; it imports no memberships, payments or historical balances, and sends no invitations. Email is required for later private password activation.</p>
      <Button variant="outline" onClick={() => download(`${RosterFields.join(',')}\nSynthetic,Member,synthetic@example.test,,1990-01-01,,,,\n`, 'shark-contact-template.csv')}>Download CSV template</Button>
      <SelectField label="Import branch" disabled={previewCall.isPending || commit.isPending} value={branchId} onChange={(e) => { setBranchId(e.target.value); invalidate(); }}><option value="">Choose a branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</SelectField>
      <Field label="CSV file" disabled={previewCall.isPending || commit.isPending} type="file" accept=".csv,text/csv" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const read = ++fileRead.current; invalidate(); setCsv(''); setFileError(''); if (file.size > 256_000) { setCsv(''); setFileError('CSV must be at most 256 KB.'); return; } void file.text().then((text) => { if (read !== fileRead.current) return; setCsv(text); setMapping({}); }).catch(() => { if (read === fileRead.current) setFileError('Could not read this file.'); }); }} />
      {fileError ? <p role="alert">{fileError}</p> : null}
      {preview ? <div className="grid gap-2 sm:grid-cols-3">{RosterFields.map((field) => <SelectField key={field} label={field} disabled={previewCall.isPending || commit.isPending} value={mapping[field] ?? (preview.headers.includes(field) ? field : '')} onChange={(e) => { setMapping((old) => ({ ...old, [field]: e.target.value })); setConfirmed(false); setAttempt(''); setResult(null); }}><option value="">Not mapped</option>{preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}</SelectField>)}</div> : null}
      <Button variant="outline" disabled={!csv || !branchId || previewCall.isPending || commit.isPending} onClick={() => { commit.reset(); previewCall.mutate(); }}>Validate and preview</Button>
      {preview ? <p className="text-sm">{preview.ready} ready · {preview.skipped} skipped · {preview.rejected} rejected. Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}. Only ready rows will be created.</p> : null}
      {rows ? <><div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Row</th><th>Name</th><th>Result</th><th>Details</th></tr></thead><tbody>{rows.map((row) => <tr key={row.row}><td>{row.row}</td><td>{row.name}</td><td>{row.status}</td><td>{row.memberNo ? `${row.memberNo}: ` : ''}{row.messages.join(' ')}</td></tr>)}</tbody></table></div><Button variant="outline" onClick={() => download([['Row', 'Name', 'Status', 'Member number', 'Details'].map(csvReportCell).join(','), ...rows.map((row) => [row.row, row.name, row.status, row.memberNo ?? '', row.messages.join(' ')].map(csvReportCell).join(','))].join('\r\n'), 'shark-import-results.csv')}>Download row results</Button></> : null}
      {preview && !result ? <><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I reviewed the mapped contacts, skipped/rejected rows and branch. Create only the {preview.ready} ready contacts; no financial history is being migrated.</label><Button variant="cta" disabled={!confirmed || !attempt || !preview.ready || commit.isPending} onClick={() => commit.mutate()}>Confirm contact import</Button></> : null}
      {result ? <p role="status">Import {result.importId}: {result.imported} imported, {result.skipped} skipped, {result.rejected} rejected. Open a member profile to verify identity, issue private activation and assign an appropriate plan.</p> : null}
      {error ? <p role="alert" className="text-flare">{error instanceof ApiError ? error.message : 'Connection failed. Retry the same confirmation; do not create a new preview until the result is known.'}</p> : null}
    </div> : null}
  </Panel>;
}
