import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionTiming } from '@shark/contracts';
import { ApiError, OfflineError, api, setSessionHandlers, type StepUpChallenge } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Button, Field } from './console';
import { Modal } from './overlay';

/* ============================================================================
   The console's side of session security (PRD 04 §10.1, ENT-IAM-003).

   One component owns the three session answers the API can give any request
   (lib/api.ts "Session handlers"): the step-up re-check, "Session expired",
   and the idle warning that comes two minutes before the server would sign a
   quiet desk out. Copy here is plain: this is a security surface.
   ========================================================================= */

/** Where to come back to: the console path, search and hash, without the basepath. */
export function currentConsolePath(): string {
  const { pathname, search, hash } = window.location;
  const path = pathname.replace(/^\/admin(?=\/|$)/, '') || '/';
  return `${path}${search}${hash}`;
}

/** Only a same-console path survives a round trip through sign-in. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/sign-in')) return null;
  return value;
}

/* — Step-up ————————————————————————————————————————————————————— */

interface PendingStepUp {
  challenge: StepUpChallenge;
  resolve: () => void;
  reject: (reason: Error) => void;
}

export function StepUpDialog() {
  const [pending, setPending] = useState<PendingStepUp | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ password?: string; code?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const waiting = useRef<Promise<void> | null>(null);

  const ask = useCallback((challenge: StepUpChallenge): Promise<void> => {
    // Two requests that both need a re-check share one dialog.
    if (waiting.current) return waiting.current;
    const promise = new Promise<void>((resolve, reject) => {
      setPassword('');
      setCode('');
      setErrors({});
      setPending({ challenge, resolve, reject });
    }).finally(() => {
      waiting.current = null;
    });
    waiting.current = promise;
    return promise;
  }, []);

  useEffect(() => registerHandler('stepUp', ask), [ask]);

  const cancel = () => {
    pending?.reject(new Error('Security check cancelled'));
    setPending(null);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setErrors({});
    try {
      await api('/auth/step-up', {
        method: 'POST',
        body: { password, ...(pending.challenge.mfa ? { code: code.trim() } : {}) },
        skipSessionHandlers: true,
      });
      pending.resolve();
      setPending(null);
    } catch (error) {
      if (error instanceof ApiError) {
        const field = error.fields[0]?.path;
        if (field === 'password' || field === 'code') setErrors({ [field]: error.message });
        else setErrors({ form: error.message });
      } else if (error instanceof OfflineError) {
        setErrors({ form: 'No connection. Check the network and try again.' });
      } else {
        setErrors({ form: 'That did not work. Try again.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const mfa = pending?.challenge.mfa ?? false;
  return (
    <Modal
      open={pending !== null}
      onClose={cancel}
      title="Confirm it’s you"
      kicker="Security check"
      width="w-[min(440px,100%)]"
      footer={
        <>
          <Button variant="outline" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="cta"
            type="submit"
            form="step-up-form"
            pending={busy}
            pendingLabel="Checking…"
            disabled={!password || (mfa && !/^\d{6}$/.test(code.trim()))}
          >
            Confirm
          </Button>
        </>
      }
    >
      <form
        id="step-up-form"
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <p className="text-[13px] leading-relaxed text-foam-65">
          This action needs a fresh check of your password{mfa ? ' and the code from your authenticator app' : ''}. You
          won’t be asked again for the next five minutes.
        </p>
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
        />
        {mfa ? (
          <Field
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            error={errors.code}
          />
        ) : null}
        {errors.form ? (
          <p role="alert" className="border border-chum bg-wash-chum p-2.5 text-[13px]">
            {errors.form}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

/* — Session expired ———————————————————————————————————————————————— */

const ENDED_COPY: Record<string, string> = {
  idle: 'You were signed out because the console was left without activity. Sign in again to carry on where you were.',
  expired: 'Staff sign-ins last 12 hours. Sign in again to carry on where you were.',
  revoked: 'This session was signed out, from Your devices or by an administrator. Sign in again to carry on.',
};

export function SessionExpiredDialog({ onSignIn }: { onSignIn: (returnTo: string) => void }) {
  const ended = useAdmin((s) => s.sessionEnded);
  if (!ended) return null;
  return (
    <Modal
      open
      // Not dismissible: there is nothing behind it that would still work.
      onClose={() => undefined}
      dismissible={false}
      title="Session expired"
      kicker="Signed out"
      width="w-[min(440px,100%)]"
      footer={
        <Button variant="cta" onClick={() => onSignIn(ended.returnTo)}>
          Sign in again
        </Button>
      }
    >
      <div className="p-4">
        <p className="text-[13px] leading-relaxed text-foam-65">
          {(ended.reason && ENDED_COPY[ended.reason]) ?? ended.message}
        </p>
        <p className="mt-2 text-[12px] text-foam-45">You’ll come back to this page after signing in.</p>
      </div>
    </Modal>
  );
}

/* — Idle warning and the activity heartbeat ———————————————————————————— */

const WARN_BEFORE_MS = 2 * 60_000;
const HEARTBEAT_MS = 60_000;
const TICK_MS = 5_000;

function minutesSeconds(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Tells the server when a person is actually here (a key, a click, a scroll)
 * at most once a minute, and warns two minutes before an idle sign-out. Reads
 * the console makes in the background never count as activity, on either side.
 */
export function IdleWarning({ now = () => Date.now() }: { now?: () => number }) {
  const status = useAdmin((s) => s.status);
  const ended = useAdmin((s) => s.sessionEnded);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const lastActivity = useRef(now());
  const lastBeat = useRef(0);

  const apply = useCallback((timing: SessionTiming | null | undefined) => {
    setExpiresAt(timing?.idleExpiresAt ? Date.parse(timing.idleExpiresAt) : null);
  }, []);

  const beat = useCallback(async () => {
    lastBeat.current = now();
    try {
      const { session } = await api<{ session: SessionTiming | null }>('/auth/session/activity', { method: 'POST' });
      apply(session);
    } catch {
      /* the next request will say if the session has ended */
    }
  }, [apply, now]);

  useEffect(() => {
    if (status !== 'signed-in') return;
    let cancelled = false;
    void api<{ session: SessionTiming | null }>('/auth/session')
      .then(({ session }) => {
        if (!cancelled) apply(session);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status, apply]);

  useEffect(() => {
    if (status !== 'signed-in' || expiresAt === null) return;
    const onActivity = () => {
      lastActivity.current = now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of events) window.addEventListener(event, onActivity, { passive: true });
    const timer = window.setInterval(() => {
      const at = now();
      if (lastActivity.current > lastBeat.current && at - lastBeat.current >= HEARTBEAT_MS) void beat();
      setRemaining(expiresAt - at);
    }, TICK_MS);
    setRemaining(expiresAt - now());
    return () => {
      for (const event of events) window.removeEventListener(event, onActivity);
      window.clearInterval(timer);
    };
  }, [status, expiresAt, beat, now]);

  if (status !== 'signed-in' || ended || remaining === null || remaining > WARN_BEFORE_MS) return null;
  if (remaining <= 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-40 flex w-[min(520px,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 border border-flare bg-overlay px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
        You’ll be signed out in <span className="font-utility font-semibold tabular-nums">{minutesSeconds(remaining)}</span> because
        nothing has happened for a while.
      </p>
      <Button variant="outline" onClick={() => void beat()}>
        Stay signed in
      </Button>
    </div>
  );
}

/* — Wiring ——————————————————————————————————————————————————————— */

type HandlerName = 'stepUp' | 'sessionEnded' | 'mfaRequired';
const registered: Parameters<typeof setSessionHandlers>[0] = {};

function registerHandler<K extends HandlerName>(name: K, handler: NonNullable<Parameters<typeof setSessionHandlers>[0][K]>): () => void {
  registered[name] = handler as never;
  setSessionHandlers({ ...registered });
  return () => {
    if (registered[name] === handler) delete registered[name];
    setSessionHandlers({ ...registered });
  };
}

/** Mount once, beside the router. `onSignIn` goes to sign-in with a return path. */
export function SessionGuard({ onSignIn }: { onSignIn: (returnTo: string) => void }) {
  const endSession = useAdmin((s) => s.endSession);
  const setMfaPending = useAdmin((s) => s.setMfaPending);

  useEffect(() => registerHandler('sessionEnded', (reason, message) => endSession(reason, message, currentConsolePath())), [endSession]);
  useEffect(
    () =>
      registerHandler('mfaRequired', (state) => {
        if (useAdmin.getState().status === 'signed-in') setMfaPending(state);
      }),
    [setMfaPending],
  );

  return (
    <>
      <StepUpDialog />
      <SessionExpiredDialog onSignIn={onSignIn} />
      <IdleWarning />
    </>
  );
}
