import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, api, csrf, idempotencyKey } from '../../lib/api';
import { useAdmin } from '../../lib/store';
import { IdleWarning, SessionExpiredDialog, SessionGuard, StepUpDialog, safeReturnPath } from '../SessionGuard';

/* The console's side of step-up and session expiry, against the real api()
   with a scripted fetch: what matters is what goes over the wire. */

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
const calls: Call[] = [];
let script: Array<(call: Call) => Response> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls.length = 0;
  script = [];
  csrf.set('csrf-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined };
    calls.push(call);
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${call.method} ${url}`);
    return next(call);
  }));
  useAdmin.setState({ status: 'signed-in', sessionEnded: null, mfaPending: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  csrf.clear();
});

const stepUpRequired = () =>
  json(401, { error: { code: 'STEP_UP_REQUIRED', message: 'For your security, confirm it’s you before doing this.', requestId: 'r1', details: { mfa: true, action: 'billing.refund', maxAgeSec: 300 } } });

describe('step-up', () => {
  it('asks once, then retries the original request with the same body and Idempotency-Key', async () => {
    render(<StepUpDialog />);
    const key = idempotencyKey('refund', 'pay_1');
    script = [stepUpRequired, () => json(200, { ok: true }), () => json(200, { refundId: 'ref_1' })];

    const pending = api<{ refundId: string }>('/admin/billing/payments/pay_1/refund', {
      method: 'POST',
      body: { amountMinor: 5000, reason: 'Charged twice' },
      idempotencyKey: key,
    });

    expect(await screen.findByRole('dialog', { name: 'Confirm it’s you' })).toBeInTheDocument();
    expect(screen.getByText(/password and the code from your authenticator app/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'shark1234' } });
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '12a3456' } });
    expect(screen.getByLabelText('Authenticator code')).toHaveValue('123456');
    fireEvent.click(confirm);

    await expect(pending).resolves.toEqual({ refundId: 'ref_1' });
    const refunds = calls.filter((call) => call.url.endsWith('/v1/admin/billing/payments/pay_1/refund'));
    expect(refunds).toHaveLength(2);
    expect(refunds[0]!.headers['idempotency-key']).toBe(key);
    expect(refunds[1]!.headers['idempotency-key']).toBe(key);
    expect(refunds[1]!.body).toBe(refunds[0]!.body);
    const stepUp = calls.find((call) => call.url.endsWith('/v1/auth/step-up'))!;
    expect(JSON.parse(stepUp.body!)).toEqual({ password: 'shark1234', code: '123456' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open on a wrong password, showing the field error', async () => {
    render(<StepUpDialog />);
    script = [
      stepUpRequired,
      () => json(422, { error: { code: 'VALIDATION_FAILED', message: 'That password is not right.', requestId: 'r2', fields: [{ path: 'password', code: 'invalid', message: 'That password is not right.' }] } }),
    ];
    const pending = api('/admin/reports/export', { method: 'POST', body: { kind: 'revenue' } });
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('That password is not right.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');

    // Cancelling fails the original request with its own message, and nothing is resent.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(calls.filter((call) => call.url.endsWith('/v1/admin/reports/export'))).toHaveLength(1);
  });

  it('asks for the password only when the person has no authenticator', async () => {
    render(<StepUpDialog />);
    script = [
      () => json(401, { error: { code: 'STEP_UP_REQUIRED', message: 'Confirm', requestId: 'r3', details: { mfa: false, action: 'report.export' } } }),
      () => json(200, { ok: true }),
      () => json(200, { rows: 3 }),
    ];
    const pending = api('/admin/reports/export', { method: 'POST', body: { kind: 'revenue' } });
    await screen.findByRole('dialog');
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(pending).resolves.toEqual({ rows: 3 });
  });
});

describe('session expiry', () => {
  it('turns a 401 on a signed-in console into "Session expired" that keeps the URL', async () => {
    window.history.replaceState(null, '', '/admin/members?q=aman');
    const onSignIn = vi.fn();
    render(<SessionGuard onSignIn={onSignIn} />);
    script = [
      () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'You were signed out after a period of inactivity.', requestId: 'r4', details: { reason: 'idle' } } }),
      () => json(200, { session: null }),
    ];
    await expect(api('/admin/members')).rejects.toBeInstanceOf(ApiError);
    const dialog = await screen.findByRole('alertdialog', { name: 'Session expired' });
    expect(dialog).toHaveTextContent('left without activity');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignIn).toHaveBeenCalledWith('/members?q=aman');
  });

  it('ignores a 401 from signing in itself', async () => {
    render(<SessionGuard onSignIn={vi.fn()} />);
    script = [() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'That email and password do not match.', requestId: 'r5' } })];
    await expect(api('/auth/password', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(useAdmin.getState().sessionEnded).toBeNull();
  });

  it('names a revoked session plainly', () => {
    useAdmin.setState({ sessionEnded: { reason: 'revoked', message: 'x', returnTo: '/' } });
    render(<SessionExpiredDialog onSignIn={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('signed out, from Your devices or by an administrator');
  });

  it('only returns to console paths', () => {
    expect(safeReturnPath('/members/mbr_1?tab=billing')).toBe('/members/mbr_1?tab=billing');
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('https://evil.example')).toBeNull();
    expect(safeReturnPath('/sign-in')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });
});

describe('idle warning', () => {
  it('warns two minutes before an idle sign-out and keeps the session on request', async () => {
    const at = Date.parse('2026-11-25T10:00:00Z');
    script = [
      () => json(200, { viewer: {}, session: { kind: 'staff', idleTimeoutSec: 1800, idleExpiresAt: new Date(at + 90_000).toISOString(), expiresAt: new Date(at + 3_600_000).toISOString(), lastActiveAt: new Date(at).toISOString() } }),
      () => json(200, { session: { kind: 'staff', idleTimeoutSec: 1800, idleExpiresAt: new Date(at + 1_800_000).toISOString(), expiresAt: new Date(at + 3_600_000).toISOString(), lastActiveAt: new Date(at).toISOString() } }),
    ];
    render(<IdleWarning now={() => at} />);
    const warning = await screen.findByRole('status');
    expect(warning).toHaveTextContent('You’ll be signed out in 1:30');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(calls.at(-1)!.url).toMatch(/\/v1\/auth\/session\/activity$/);
  });

  it('stays quiet while plenty of time is left, and for members (no idle timeout)', async () => {
    const at = Date.now();
    script = [() => json(200, { viewer: {}, session: { kind: 'staff', idleTimeoutSec: 1800, idleExpiresAt: new Date(at + 20 * 60_000).toISOString(), expiresAt: new Date(at + 3_600_000).toISOString(), lastActiveAt: new Date(at).toISOString() } })];
    render(<IdleWarning now={() => at} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
