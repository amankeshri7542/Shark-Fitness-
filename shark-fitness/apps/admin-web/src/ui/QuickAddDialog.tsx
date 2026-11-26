import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, OfflineError, api, idempotencyKey } from '../lib/api';
import { useAdmin, usePermission } from '../lib/store';
import { AccountActivation } from './AccountActivation';
import { Button, Field, SelectField } from './console';
import { Modal } from './overlay';

/**
 * Quick add for a walk-in (P07; PRD 01 §4.4, Design PRD UX-A04).
 *
 * Five fields at the desk. A phone or email that already belongs to a member
 * is caught and the existing record is offered instead — the commonest desk
 * mistake is adding a returning member twice. On success the new member is
 * one click away, with the activation link for the app if they gave an email.
 */

interface Existing {
  id: string;
  name: string;
  memberNo: string;
  matchedOn: 'phone' | 'email';
}

interface Created {
  member: { id: string; memberNo: string; name: string };
  activation: { eligible: boolean; note: string };
}

export function QuickAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const branches = useAdmin((s) => s.branches);
  const activeBranchId = useAdmin((s) => s.activeBranchId);
  const canPlan = usePermission('membership.manage');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [branchId, setBranchId] = useState(activeBranchId ?? branches[0]?.id ?? '');
  const [productId, setProductId] = useState('');
  const [key, setKey] = useState(() => idempotencyKey('quick-add'));

  const plans = useQuery({
    queryKey: ['quick-add', 'plans'],
    queryFn: () => api<{ items: Array<{ id: string; name: string; kind: string; status: string; priceLabel?: string }> }>('/admin/billing/products'),
    enabled: open && canPlan,
  });

  const save = useMutation({
    mutationFn: () =>
      api<Created>('/admin/members/quick-add', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          name: name.trim(),
          phone: phone.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          branchId,
          ...(productId ? { productId } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: () => setKey(idempotencyKey('quick-add')),
  });

  const existing = save.error instanceof ApiError && save.error.status === 409 ? (save.error.details?.existing as Existing | undefined) : undefined;
  const error =
    save.error instanceof OfflineError
      ? 'No connection. Nobody was added.'
      : save.error instanceof ApiError
        ? save.error.message
        : save.error
          ? 'They were not added. Try again.'
          : null;
  const created = save.data;
  const valid = name.trim().length >= 2 && phone.replace(/\D/g, '').length >= 8 && Boolean(branchId);

  return (
    <Modal open={open} title={created ? 'Member added' : 'Add a member'} onClose={onClose}>
      {created ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px]">
            {created.member.name} is {created.member.memberNo}.
          </p>
          <p className="text-[12px] text-foam-65">{created.activation.note}</p>
          {created.activation.eligible ? <AccountActivation memberId={created.member.id} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            <Link to="/members/$memberId" params={{ memberId: created.member.id }} onClick={onClose}>
              <Button variant="cta">Open member</Button>
            </Link>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Field label="Full name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Phone" type="tel" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
            <Field label="Email (optional)" type="email" value={email} maxLength={200} onChange={(e) => setEmail(e.target.value)} hint="Needed to send an app activation link." />
            {branches.length > 1 ? (
              <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </SelectField>
            ) : null}
            {canPlan ? (
              <SelectField label="Plan (optional)" value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">No plan yet</option>
                {(plans.data?.items ?? [])
                  .filter((p) => p.status === 'active')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.priceLabel ? ` · ${p.priceLabel}` : ''}
                    </option>
                  ))}
              </SelectField>
            ) : null}
          </div>
          {existing ? (
            <div className="flex flex-wrap items-center gap-2 bg-wash-flare p-3" role="alert">
              <p className="flex-1 text-[13px]">
                {existing.name} ({existing.memberNo}) already has this {existing.matchedOn}.
              </p>
              <Link to="/members/$memberId" params={{ memberId: existing.id }} onClick={onClose} className="text-[13px] text-sonar underline">
                Open {existing.name}
              </Link>
            </div>
          ) : error ? (
            <p role="alert" className="text-[12px] text-chum">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="cta" disabled={!valid} pending={save.isPending} pendingLabel="Adding">
              Add member
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
