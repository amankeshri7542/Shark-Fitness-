import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, idempotencyKey, OfflineError } from './api';

/**
 * Razorpay Checkout for the member app (P02).
 *
 * Checkout.js is loaded on demand, only from Razorpay's own origin, and only
 * when the member taps Pay — never on app start. What the browser says about
 * a payment is a claim: the server verifies the signature, asks Razorpay
 * itself, and only then marks anything paid. Until it has, the app says
 * "confirming" and waits for the server, by realtime event (which invalidates
 * the `billing` queries) with polling as the fallback.
 *
 * Retrying the same thing reuses the same Idempotency-Key, so a second tap,
 * a retry after a failure or a flaky connection resumes the same Razorpay
 * order instead of creating another one.
 */

export const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

export interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayFailure {
  error?: { code?: string; description?: string; reason?: string; metadata?: { payment_id?: string; order_id?: string } };
}

export interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (response: RazorpayFailure) => void): void;
}

export type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loading: Promise<RazorpayConstructor> | null = null;

/** Inject checkout.js once. A failed load can be retried. */
export function loadCheckout(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay Checkout did not start.')));
    script.onerror = () => {
      script.remove();
      reject(new Error('Razorpay Checkout could not be loaded.'));
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export type CheckoutServerState = 'processing' | 'succeeded' | 'failed' | 'needs_review' | 'expired';

export interface CheckoutStatus {
  intentId: string;
  invoiceId: string;
  state: CheckoutServerState;
  amountLabel: string;
  paymentId: string | null;
  failureReason: string | null;
}

export interface CheckoutSession extends CheckoutStatus {
  orderId: string | null;
  keyId: string;
  amountMinor: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string | null; contact: string | null };
}

type PlanCheckout = ({ kind: 'checkout' } & CheckoutSession) | { kind: 'activated'; invoiceId: string; membershipId: string };

/** What is being paid for. `key` identifies it across retries. */
export type CheckoutTarget =
  | { kind: 'invoice'; invoiceId: string; label: string }
  | { kind: 'plan'; productId: string; label: string };

export type CheckoutState =
  | { phase: 'idle' }
  | { phase: 'opening'; target: CheckoutTarget }
  | { phase: 'dismissed'; target: CheckoutTarget }
  | { phase: 'failed'; target: CheckoutTarget; reason: string }
  | { phase: 'confirming'; target: CheckoutTarget; intentId: string; slow: boolean }
  | { phase: 'paid'; target: CheckoutTarget; invoiceId: string; paymentId: string | null; amountLabel: string | null }
  | { phase: 'review'; target: CheckoutTarget };

const targetKey = (target: CheckoutTarget) => (target.kind === 'invoice' ? `invoice:${target.invoiceId}` : `plan:${target.productId}`);

export const COPY = {
  failedFallback: 'The payment did not go through. If money left your account, your bank returns it automatically.',
  scriptFailed: 'The secure payment window could not load. Check your connection and try again. Nothing was charged.',
  offline: 'You are offline. Nothing was charged. Try again when you are connected.',
  expired: 'This payment request is out of date because the amount owed changed. Try again to pay the current amount.',
};

/** After this long confirming, say so (the bank can take minutes). */
const SLOW_AFTER_MS = 30_000;

export function useCheckout() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CheckoutState>({ phase: 'idle' });
  const keys = useRef(new Map<string, string>());

  const settle = useCallback(
    (target: CheckoutTarget, status: CheckoutStatus) => {
      if (status.state === 'succeeded') {
        // Paid: the next attempt at anything is a new request.
        keys.current.delete(targetKey(target));
        setState({ phase: 'paid', target, invoiceId: status.invoiceId, paymentId: status.paymentId, amountLabel: status.amountLabel });
        void queryClient.invalidateQueries({ queryKey: ['billing'] });
        void queryClient.invalidateQueries({ queryKey: ['home'] });
        return true;
      }
      if (status.state === 'failed') {
        setState({ phase: 'failed', target, reason: status.failureReason || COPY.failedFallback });
        return true;
      }
      if (status.state === 'needs_review') {
        setState({ phase: 'review', target });
        return true;
      }
      if (status.state === 'expired') {
        keys.current.delete(targetKey(target));
        setState({ phase: 'failed', target, reason: COPY.expired });
        return true;
      }
      return false;
    },
    [queryClient],
  );

  const confirm = useCallback(
    async (target: CheckoutTarget, intentId: string, response: RazorpaySuccess) => {
      setState({ phase: 'confirming', target, intentId, slow: false });
      try {
        const status = await api<CheckoutStatus>(`/member/billing/checkout/${intentId}/confirm`, { method: 'POST', body: response });
        settle(target, status);
      } catch (error) {
        // Offline or a server hiccup: keep confirming; the status poll and
        // realtime carry on until the server knows.
        if (error instanceof ApiError && error.status < 500) {
          setState({ phase: 'failed', target, reason: error.message });
        }
      }
    },
    [settle],
  );

  const pay = useCallback(
    async (target: CheckoutTarget) => {
      const id = targetKey(target);
      const key = keys.current.get(id) ?? idempotencyKey('checkout', id);
      keys.current.set(id, key);
      setState({ phase: 'opening', target });

      let session: CheckoutSession;
      try {
        if (target.kind === 'invoice') {
          session = await api<CheckoutSession>(`/member/billing/invoices/${target.invoiceId}/checkout`, { method: 'POST', idempotencyKey: key });
        } else {
          const result = await api<PlanCheckout>(`/member/billing/plans/${target.productId}/checkout`, { method: 'POST', idempotencyKey: key });
          if (result.kind === 'activated') {
            keys.current.delete(id);
            setState({ phase: 'paid', target, invoiceId: result.invoiceId, paymentId: null, amountLabel: null });
            void queryClient.invalidateQueries({ queryKey: ['billing'] });
            return;
          }
          session = result;
        }
      } catch (error) {
        const reason = error instanceof OfflineError ? COPY.offline : error instanceof ApiError ? error.message : COPY.failedFallback;
        if (error instanceof ApiError && error.status === 409) void queryClient.invalidateQueries({ queryKey: ['billing'] });
        setState({ phase: 'failed', target, reason });
        return;
      }

      if (settle(target, session) && session.state !== 'failed') return;
      if (!session.orderId) {
        setState({ phase: 'failed', target, reason: COPY.failedFallback });
        return;
      }

      let Razorpay: RazorpayConstructor;
      try {
        Razorpay = await loadCheckout();
      } catch {
        setState({ phase: 'failed', target, reason: COPY.scriptFailed });
        return;
      }

      setState({ phase: 'opening', target });
      let completed = false;
      let lastFailure: string | null = null;
      const checkout = new Razorpay({
        key: session.keyId,
        amount: session.amountMinor,
        currency: session.currency,
        name: session.name,
        description: session.description,
        order_id: session.orderId,
        prefill: {
          name: session.prefill.name,
          ...(session.prefill.email ? { email: session.prefill.email } : {}),
          ...(session.prefill.contact ? { contact: session.prefill.contact } : {}),
        },
        // Carried onto the payment, so reconciliation can trace it home.
        notes: { intent_id: session.intentId, invoice_id: session.invoiceId },
        theme: { color: '#46c8dd' },
        handler: (response: RazorpaySuccess) => {
          completed = true;
          void confirm(target, session.intentId, response);
        },
        modal: {
          ondismiss: () => {
            if (completed) return;
            setState(lastFailure ? { phase: 'failed', target, reason: lastFailure } : { phase: 'dismissed', target });
          },
        },
      });
      // Razorpay keeps its window open after a failed attempt so the member can
      // try another method; remember why, in case they close it instead.
      checkout.on('payment.failed', (response) => {
        lastFailure = response.error?.description || COPY.failedFallback;
      });
      checkout.open();
    },
    [confirm, queryClient, settle],
  );

  // While confirming: the server's word, by realtime invalidation of
  // ['billing', …] or by polling every two seconds.
  const confirmingId = state.phase === 'confirming' ? state.intentId : null;
  const status = useQuery({
    queryKey: ['billing', 'checkout', confirmingId],
    queryFn: () => api<CheckoutStatus>(`/member/billing/checkout/${confirmingId}`),
    enabled: confirmingId !== null,
    refetchInterval: 2_000,
    gcTime: 0,
  });
  useEffect(() => {
    if (state.phase === 'confirming' && status.data && status.data.intentId === state.intentId) settle(state.target, status.data);
  }, [settle, state, status.data]);
  useEffect(() => {
    if (state.phase !== 'confirming' || state.slow) return;
    const timer = setTimeout(() => setState((current) => (current.phase === 'confirming' ? { ...current, slow: true } : current)), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  const busy = state.phase === 'opening' || state.phase === 'confirming';
  return { state, pay, reset, busy };
}
