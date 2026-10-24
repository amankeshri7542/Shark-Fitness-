import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { Button, Field, Panel } from './console';

interface Activation { activationId: string; token: string; expiresAt: string; tenantSlug: string; email: string }

export function AccountActivation({ memberId, staffId }: { memberId?: string; staffId?: string }) {
  const issue = useMutation({
    mutationFn: () => api<Activation>('/auth/activation/issue', { method: 'POST', body: { memberId, staffId } }),
  });
  const result = issue.data;
  const appOrigin = new URL(window.location.origin);
  if (import.meta.env.DEV && !staffId && appOrigin.port === '5174') appOrigin.port = '5173';
  const link = result ? `${appOrigin.origin}${staffId ? '/admin' : ''}/sign-in#${new URLSearchParams({
    activationId: result.activationId, activationToken: result.token, gym: result.tenantSlug,
  })}` : '';
  return <Panel title="Account activation" className="border-b border-line">
    <div className="space-y-3 p-3.5">
      <p className="text-[12px] text-foam-65">For a new account without a password. Verify identity in person, then privately hand over the one-time link. No email or SMS is sent.</p>
      <Button variant="outline" disabled={issue.isPending} onClick={() => issue.mutate()}>
        {issue.isPending ? 'Creating…' : 'Create activation link'}
      </Button>
      {issue.error ? <p role="alert" className="text-[12px] text-chum">{issue.error instanceof ApiError ? issue.error.message : 'Could not create an activation link. Try again.'}</p> : null}
      {result ? <>
        <Field label="Private activation link" value={link} readOnly onFocus={(event) => event.currentTarget.select()} />
        <p className="text-[12px] text-foam-65">For {result.email}. Expires {new Date(result.expiresAt).toLocaleString()}. Creating another link invalidates this one.</p>
        <Button variant="ghost" onClick={() => issue.reset()}>Hide link</Button>
      </> : null}
    </div>
  </Panel>;
}
