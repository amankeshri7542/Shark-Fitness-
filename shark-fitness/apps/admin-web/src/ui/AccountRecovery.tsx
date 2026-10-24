import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Button, Field, Panel } from './console';

interface Recovery { recoveryId: string; token: string; expiresAt: string; tenantSlug: string; email: string }

export function AccountRecovery({ memberId, staffId }: { memberId?: string; staffId?: string }) {
  const owner = useAdmin((state) => state.viewer?.role === 'owner');
  const [currentPassword, setCurrentPassword] = useState('');
  const [reason, setReason] = useState('');
  const [identityVerified, setIdentityVerified] = useState(false);
  const [result, setResult] = useState<Recovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const issue = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await api<Recovery>('/auth/recovery/issue', { method: 'POST', body: { memberId, staffId, currentPassword, reason, identityVerified } }));
      setIdentityVerified(false);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not issue a recovery link. Check the connection and try again.'); }
    finally { setCurrentPassword(''); setBusy(false); }
  };
  const appOrigin = new URL(window.location.origin);
  if (import.meta.env.DEV && !staffId && appOrigin.port === '5174') appOrigin.port = '5173';
  const link = result ? `${appOrigin.origin}${staffId ? '/admin' : ''}/sign-in#${new URLSearchParams({ recoveryId: result.recoveryId, recoveryToken: result.token, gym: result.tenantSlug })}` : '';
  if (!owner) return null;
  return <Panel title="Existing account recovery" className="border-b border-line">
    <div className="space-y-3 p-3.5">
      <p className="text-[12px] text-foam-65">Owner-supervised recovery for an active member or currently employed staff account with an existing password. Verify identity in person against the gym’s records before handing over the link privately. No email or SMS is sent. Owner accounts are excluded.</p>
      <Field label="Recovery reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} hint="At least 10 characters. Describe the reason; do not record identity-document numbers or passwords." />
      <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" checked={identityVerified} onChange={(event) => setIdentityVerified(event.target.checked)} />I verified this person’s identity in person against the gym’s existing records.</label>
      <Field label="Your current owner password" type="password" autoComplete="current-password" value={currentPassword} maxLength={128} onChange={(event) => setCurrentPassword(event.target.value)} />
      <Button variant="outline" disabled={busy || !identityVerified || reason.trim().length < 10 || !currentPassword} onClick={() => void issue()}>{busy ? 'Creating…' : 'Create recovery link'}</Button>
      {error ? <p role="alert" className="text-[12px] text-chum">{error}</p> : null}
      {result ? <>
        <Field label="Private recovery link" value={link} readOnly onFocus={(event) => event.currentTarget.select()} />
        <p className="text-[12px] text-foam-65">For {result.email}. Expires {new Date(result.expiresAt).toLocaleString()}. A replacement invalidates older links. The recipient privately chooses their password; completion signs out every previous session. Roles, disabled states and membership access do not change.</p>
        <Button variant="ghost" onClick={() => setResult(null)}>Hide recovery link</Button>
      </> : null}
    </div>
  </Panel>;
}
