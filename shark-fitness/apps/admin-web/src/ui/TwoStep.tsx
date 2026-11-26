import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { encode } from 'uqr';
import type { MfaEnrolment, MfaStatus, Viewer } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Button, Checkbox, Display, Field, Label, Skeleton } from './console';

/* ============================================================================
   Two-step sign-in (ADR-004): the QR code, enrolment, the sign-in challenge,
   and the full-screen gate a session meets when it still owes one of them.
   Plain copy throughout — this is an access surface.
   ========================================================================= */

function messageOf(error: unknown): string {
  if (error instanceof OfflineError) return 'No connection. Check the network and try again.';
  if (error instanceof ApiError) return error.message;
  return 'That did not work. Try again.';
}

/**
 * The `otpauth://` URI as a QR code, drawn as SVG squares. Dark on white
 * whatever the theme: authenticator cameras read contrast, not brand colour.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value]);
  const cells: Array<[number, number]> = [];
  qr.data.forEach((row, y) => row.forEach((dark, x) => dark && cells.push([x, y])));
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className="h-[184px] w-[184px] flex-none"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      {cells.map(([x, y]) => (
        <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill="#04080b" />
      ))}
    </svg>
  );
}

/** "ABCD EFGH …": the manual key in groups a person can read out and type. */
export function groupKey(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Shown once, straight after enrolment or regeneration. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const download = () => {
    const blob = new Blob(
      [`Shark Fitness recovery codes\nEach code works once. Keep them somewhere safe and private.\n\n${codes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'shark-fitness-recovery-codes.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-foam-65">
        If you lose your phone, each of these codes signs you in once instead of an authenticator code. They are shown
        only now. Store them in a password manager or print them, and keep them private.
      </p>
      <ol aria-label="Recovery codes" className="grid grid-cols-2 gap-x-6 gap-y-1.5 border border-line bg-panel p-3">
        {codes.map((code) => (
          <li key={code} className="font-utility text-[14px] font-semibold tracking-[0.12em] tabular-nums">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void copy(codes.join('\n')).then(setCopied)}>
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button variant="outline" onClick={download}>
          Download as text
        </Button>
      </div>
      <Checkbox label="I have stored these codes somewhere safe" checked={stored} onChange={(event) => setStored(event.target.checked)} />
      <div>
        <Button variant="cta" size="md" disabled={!stored} onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}

/** Scan, type the first code, keep the recovery codes. */
export function MfaEnrolmentFlow({ onEnrolled, doneLabel }: { onEnrolled: (result: { viewer: Viewer }) => void; doneLabel?: string }) {
  const setup = useQuery({
    queryKey: ['mfa', 'enrol', 'start'],
    queryFn: () => api<MfaEnrolment>('/auth/mfa/enrol/start', { method: 'POST' }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ viewer: Viewer; recoveryCodes: string[] } | null>(null);
  const [copied, setCopied] = useState(false);

  if (result) {
    return (
      <div className="flex flex-col gap-3">
        <Label>Two-step sign-in is on</Label>
        <Display size="sm" as="h2">
          Save your recovery codes
        </Display>
        <RecoveryCodes codes={result.recoveryCodes} doneLabel={doneLabel} onDone={() => onEnrolled(result)} />
      </div>
    );
  }

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<{ viewer: Viewer; recoveryCodes: string[] }>('/auth/mfa/enrol/confirm', { method: 'POST', body: { code: code.trim() } }));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] leading-relaxed text-foam-65">
        <li>Open an authenticator app on your phone — Google Authenticator, Microsoft Authenticator, 1Password or similar.</li>
        <li>Scan the code below, or type the setup key into the app.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {setup.isPending ? (
        <div className="flex gap-4">
          <Skeleton className="h-[184px] w-[184px]" />
          <Skeleton className="h-20 flex-1" />
        </div>
      ) : setup.isError ? (
        <div role="alert" className="border border-chum bg-wash-chum p-3 text-[13px]">
          {messageOf(setup.error)}{' '}
          <Button variant="ghost" onClick={() => void setup.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <QrCode value={setup.data.uri} label={`QR code to add ${setup.data.account} to an authenticator app`} />
          <div className="flex min-w-[220px] flex-1 flex-col gap-2">
            <Label>Setup key</Label>
            <code className="break-all border border-line bg-panel px-2.5 py-2 font-utility text-[14px] font-semibold tracking-[0.08em]" data-testid="mfa-setup-key">
              {groupKey(setup.data.secret)}
            </code>
            <p className="text-[12px] text-foam-45">
              Account: {setup.data.account} · Issuer: {setup.data.issuer} · Time-based
            </p>
            <div>
              <Button variant="outline" onClick={() => void copy(setup.data.secret).then(setCopied)}>
                {copied ? 'Copied' : 'Copy key'}
              </Button>
            </div>
          </div>
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <Field
          label="6-digit code"
          className="w-[180px]"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          error={error ?? undefined}
          disabled={!setup.isSuccess}
        />
        <Button variant="cta" size="md" type="submit" pending={busy} pendingLabel="Checking…" disabled={!setup.isSuccess || code.length !== 6}>
          Turn on
        </Button>
      </form>
    </div>
  );
}

/** The sign-in challenge: an authenticator code, or one recovery code. */
export function MfaChallengeForm({ onVerified }: { onVerified: (result: { viewer: Viewer; recoveryCodesRemaining?: number }) => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = useRecovery ? /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(value.trim()) : /^\d{6}$/.test(value);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ viewer: Viewer; recoveryCodesRemaining?: number }>('/auth/mfa/verify', {
        method: 'POST',
        body: useRecovery ? { recoveryCode: value.trim() } : { code: value },
      });
      onVerified(result);
    } catch (failure) {
      setError(messageOf(failure));
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13px] leading-relaxed text-foam-65">
        {useRecovery
          ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <Field
        key={useRecovery ? 'recovery' : 'code'}
        label={useRecovery ? 'Recovery code' : 'Authenticator code'}
        autoFocus
        inputMode={useRecovery ? 'text' : 'numeric'}
        autoComplete={useRecovery ? 'off' : 'one-time-code'}
        maxLength={useRecovery ? 11 : 6}
        value={value}
        onChange={(event) => setValue(useRecovery ? event.target.value.toUpperCase() : event.target.value.replace(/\D/g, ''))}
        error={error ?? undefined}
      />
      <Button variant="cta" size="md" full type="submit" pending={busy} pendingLabel="Checking…" disabled={!valid}>
        Verify
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setUseRecovery(!useRecovery);
          setValue('');
          setError(null);
        }}
      >
        {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code'}
      </Button>
    </form>
  );
}

/**
 * What a session that still owes MFA sees instead of the console: the code
 * prompt, or — for owners, managers and platform staff, or anyone whose gym
 * requires it — the enrolment it cannot skip.
 */
export function TwoStepGate({ state, onComplete }: { state: 'challenge' | 'enrol'; onComplete: () => void }) {
  const signOut = useAdmin((s) => s.signOut);
  const status = useQuery({
    queryKey: ['mfa', 'status', state],
    queryFn: () => api<MfaStatus>('/auth/mfa'),
    enabled: state === 'enrol',
    retry: false,
  });
  const why =
    status.data?.requiredBy === 'gym'
      ? 'Your gym requires two-step sign-in for all staff.'
      : 'Owners, regional managers and platform staff must use two-step sign-in, because their accounts can change money, people and data.';

  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <main className="flex w-[min(620px,100%)] flex-col gap-4 border border-line p-6 md:p-8">
        <div className="flex items-center gap-2.5">
          <span className="font-display text-[20px] uppercase leading-none tracking-[0.06em]">Shark</span>
          <span aria-hidden="true" className="h-1 w-5" style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }} />
          <Label>Two-step sign-in</Label>
        </div>
        <Display size="md" as="h1">
          {state === 'enrol' ? 'Set up two-step sign-in' : 'Enter your code'}
        </Display>
        {state === 'enrol' ? (
          <>
            <p className="text-[13px] leading-relaxed text-foam-65">{why} It takes about a minute.</p>
            <MfaEnrolmentFlow onEnrolled={onComplete} doneLabel="Continue to the console" />
          </>
        ) : (
          <MfaChallengeForm onVerified={onComplete} />
        )}
        <div className="border-t border-line pt-3">
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
          <p className="mt-1 text-[12px] leading-relaxed text-foam-45">
            Lost your phone and your recovery codes? Ask your gym owner to reset two-step sign-in for you. Owners can ask
            Shark Fitness support, who will confirm it is you first.
          </p>
        </div>
      </main>
    </div>
  );
}
