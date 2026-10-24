import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Button, Field, Panel } from '../ui/console';

export interface EditableMember {
  id: string; name: string; firstName: string; lastName: string; version: number;
  email: string | null; phone: string | null; dob: string | null; addressLine: string | null;
  emergencyContact: { name: string; phone: string; relationship: string } | null;
  importedContactOnly?: boolean;
}
export function MemberEditor({ member, onSaved }: { member: EditableMember; onSaved: () => void }) {
  const owner = useAdmin((s) => s.viewer?.role === 'owner');
  const [mode, setMode] = useState<'profile' | 'identity' | null>(null);
  const initialFields = { firstName: member.firstName ?? member.name.split(' ')[0] ?? '', lastName: member.lastName ?? member.name.split(' ').slice(1).join(' '), dob: member.dob ?? '', addressLine: member.addressLine ?? '', emergencyName: member.emergencyContact?.name ?? '', emergencyPhone: member.emergencyContact?.phone ?? '', relationship: member.emergencyContact?.relationship ?? '', email: member.email ?? '', phone: member.phone ?? '', reason: '', currentPassword: '' };
  const [fields, setFields] = useState(initialFields);
  const [verified, setVerified] = useState(false);
  const change = (field: keyof typeof fields, value: string) => setFields((old) => ({ ...old, [field]: value }));
  const mutation = useMutation({
    mutationFn: () => api(`/admin/members/${member.id}/${mode}`, { method: 'PATCH', body: mode === 'identity' ? {
      version: member.version, email: fields.email.trim() || null, phone: fields.phone.trim() || null, reason: fields.reason, currentPassword: fields.currentPassword, identityVerified: verified,
    } : { version: member.version, firstName: fields.firstName, lastName: fields.lastName, dob: fields.dob || null, addressLine: fields.addressLine.trim() || null,
      emergencyContact: fields.emergencyName || fields.emergencyPhone || fields.relationship ? { name: fields.emergencyName, phone: fields.emergencyPhone, relationship: fields.relationship } : null, reason: fields.reason } }),
    onSuccess: () => { setMode(null); onSaved(); },
    onSettled: () => { change('currentPassword', ''); setVerified(false); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(); };
  return <Panel className="p-4">
    <h2 className="mb-2 font-heading text-lg text-foam">Member details</h2>
    {member.importedContactOnly ? <p className="mb-3 text-sm text-flare">Imported contact: historical balances and memberships were not imported. Verify existing obligations separately; arrange a plan and private activation when needed.</p> : null}
    <p className="mb-3 text-sm text-foam-65">Login email: {member.email ?? 'Not provided'} · Phone: {member.phone ?? 'Not provided'}. Only the owner can verify and change login identity.</p>
    {!mode ? <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { mutation.reset(); setFields(initialFields); setMode('profile'); }}>Correct details</Button>{owner ? <Button variant="outline" onClick={() => { mutation.reset(); setFields(initialFields); setVerified(false); setMode('identity'); }}>Correct login identity</Button> : null}</div> : <form onSubmit={submit} className="flex flex-col gap-3">
      {mode === 'profile' ? <>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="First name" required maxLength={100} value={fields.firstName} onChange={(e) => change('firstName', e.target.value)} /><Field label="Last name" maxLength={100} value={fields.lastName} onChange={(e) => change('lastName', e.target.value)} /></div>
        <Field label="Date of birth" type="date" value={fields.dob} onChange={(e) => change('dob', e.target.value)} />
        <Field label="Address" maxLength={500} value={fields.addressLine} onChange={(e) => change('addressLine', e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Emergency contact name" maxLength={100} value={fields.emergencyName} onChange={(e) => change('emergencyName', e.target.value)} /><Field label="Emergency contact phone" maxLength={24} value={fields.emergencyPhone} onChange={(e) => change('emergencyPhone', e.target.value)} /><Field label="Relationship" maxLength={100} value={fields.relationship} onChange={(e) => change('relationship', e.target.value)} /></div>
      </> : <>
        <p className="text-sm text-flare">Verify the person and new contact in person. This changes sign-in identity, invalidates outstanding handoffs and signs the member out. It sends no email or SMS.</p>
        <Field label="New login email" type="email" maxLength={254} value={fields.email} onChange={(e) => change('email', e.target.value)} />
        <Field label="New phone" maxLength={24} value={fields.phone} onChange={(e) => change('phone', e.target.value)} />
        <Field label="Current owner password" type="password" autoComplete="current-password" required value={fields.currentPassword} onChange={(e) => change('currentPassword', e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />I verified this person and the new contact in person.</label>
      </>}
      <Field label="Correction reason" required minLength={4} maxLength={500} value={fields.reason} onChange={(e) => change('reason', e.target.value)} />
      {mutation.error ? <p role="alert" className="text-sm text-flare">{mutation.error instanceof ApiError ? mutation.error.message : 'Could not save. Check the connection and retry; reload if someone else changed this profile.'}</p> : null}
      <div className="flex flex-wrap gap-2"><Button variant="cta" type="submit" disabled={mutation.isPending || (mode === 'identity' && !verified)}>Save correction</Button><Button variant="outline" type="button" disabled={mutation.isPending} onClick={() => { setMode(null); change('currentPassword', ''); setVerified(false); }}>Cancel correction</Button></div>
    </form>}
  </Panel>;
}
