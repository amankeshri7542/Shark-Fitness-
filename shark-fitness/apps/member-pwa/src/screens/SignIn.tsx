import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { StartOtpResult, Viewer } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../lib/api';
import { useSession } from '../lib/store';
import { setMemberSessionHint } from '../lib/session-hint';
import { Button, Display, Eyebrow, Field, Panel, Scanlines, SonarSweep } from '../ui/primitives';

interface SignInResult {
  viewer: Viewer;
  csrfToken: string;
}



export default function SignInScreen() {
  const navigate = useNavigate();
  const [activation, setActivation] = useState(() => new URLSearchParams(window.location.hash.slice(1)));
  const activationId = activation.get('activationId');
  const activationToken = activation.get('activationToken');
  const activating = Boolean(activationId && activationToken);
  const recoveryId = activation.get('recoveryId');
  const recoveryToken = activation.get('recoveryToken');
  const recovering = Boolean(recoveryId && recoveryToken);
  const choosingPassword = activating || recovering;
  const [recovered, setRecovered] = useState(false);
  const [tenantSlug, setTenantSlug] = useState(activation.get('gym') ?? (import.meta.env.DEV ? 'shark' : ''));

  const bootstrap = useSession((state) => state.bootstrap);

  const [mode, setMode] = useState<'otp' | 'password'>(choosingPassword || !import.meta.env.DEV ? 'password' : 'otp');
  const [step, setStep] = useState<'identify' | 'verify'>('identify');
  const [identifier, setIdentifier] = useState(import.meta.env.DEV ? 'aman@sharkfitness.in' : '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<StartOtpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const readActivation = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      setActivation(params);
      if (params.get('gym')) setTenantSlug(params.get('gym')!);
      setError(null);
      if (params.get('activationId') || params.get('recoveryId')) { setMode('password'); setStep('identify'); }
    };
    window.addEventListener('hashchange', readActivation);
    return () => window.removeEventListener('hashchange', readActivation);
  }, []);


  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof OfflineError) {
        setError('No connection. Signing in needs one — everything else works offline.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('That did not work. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const startOtp = () =>
    run(async () => {
      const result = await api<StartOtpResult>('/auth/otp/start', {
        method: 'POST',
        body: { identifier, tenantSlug: tenantSlug.trim() },
      });
      setChallenge(result);
      setCode(result.delivery === 'development_echo' ? result.devCode : '');
      setStep('verify');
    });

  const finish = async (result: SignInResult): Promise<void> => {
    if (activating) window.history.replaceState(null, '', window.location.pathname);
    if (result.viewer.role !== 'member') {
      await api('/auth/sign-out', { method: 'POST' });
      setError('That is a staff account. Use the gym dashboard to sign in.');
      return;
    }
    // This is only a non-sensitive browser hint. Authentication itself remains
    // in the HttpOnly cookie returned by the API.
    setMemberSessionHint(true);
    useSession.getState().setViewer(result.viewer);
    await bootstrap();
    if (useSession.getState().status !== 'signed-in') {
      setMemberSessionHint(false);
      throw new Error('Session bootstrap failed after sign-in');
    }
    await navigate({ to: '/' });
  };

  const verifyOtp = () =>
    run(async () => {
      const result = await api<SignInResult>('/auth/otp/verify', {
        method: 'POST',
        body: { challengeId: challenge?.challengeId, code },
      });
      await finish(result);
    });

  const signInWithPassword = () =>
    run(async () => {
      if (recovering) {
        await api('/auth/recovery/redeem', { method: 'POST', body: { recoveryId, token: recoveryToken, password } });
        window.history.replaceState(null, '', window.location.pathname);
        setActivation(new URLSearchParams()); setPassword(''); setIdentifier(''); setRecovered(true);
        return;
      }
      const result = await api<SignInResult>(activating ? '/auth/activation/redeem' : '/auth/password', {
        method: 'POST',
        body: activating ? { activationId, token: activationToken, password } : { tenantSlug: tenantSlug.trim(), email: identifier, password },
      });
      await finish(result);
    });

  return (
    <div className="relative flex h-full flex-col overflow-y-auto">
      <div
        className="relative overflow-hidden px-5 pb-8 pt-14"
        style={{
          background: 'linear-gradient(180deg, var(--sf-shelf-top) 0%, var(--sf-shelf-mid) 55%, var(--sf-abyss) 100%)',
        }}
      >
        <Scanlines />
        <SonarSweep />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span className="font-display text-[26px] uppercase leading-none tracking-[0.06em]">Shark</span>
            <span
              aria-hidden="true"
              className="h-1.5 w-6"
              style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
            />
          </div>
          <Display size="xl" className="mt-6">
            Down
            <br />
            <span className="text-sonar">where it counts</span>
          </Display>
          <p className="mt-3 max-w-[32ch] text-[13px] leading-relaxed text-foam-65">
            Your membership, your plan and your gym.
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        {step === 'identify' ? (
          <>
            {recovered ? <p role="status">Your password has been changed and previous sessions signed out. Sign in with your new password.</p> : null}
            {recovering ? <p>Privately choose a new password (at least 12 characters). This recovery link works once and signs out all previous sessions.</p> : activating ? <p>Create your password (at least 12 characters). This activation link works once.</p> : <Field label="Gym code" value={tenantSlug} onChange={(event) => setTenantSlug(event.target.value)} />}
            {!choosingPassword ? <Field
              label={mode === 'otp' ? 'Email or phone' : 'Email'}
              type={mode === 'otp' ? 'text' : 'email'}
              inputMode={mode === 'otp' ? 'email' : undefined}
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              hint={mode === 'otp' ? 'Request a six-digit sign-in code.' : undefined}
            /> : null}

            {mode === 'password' ? (
              <Field
                label="Password"
                type="password"
                autoComplete={choosingPassword ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            ) : null}

            {error ? (
              <Panel tone="bad" className="p-3">
                <p className="text-[13px] leading-relaxed text-foam-80">{error}</p>
              </Panel>
            ) : null}

            <Button
              variant="cta"
              size="lg"
              full
              disabled={busy || (choosingPassword ? password.length < 12 : identifier.length < 3 || !tenantSlug.trim())}
              onClick={() => void (mode === 'otp' ? startOtp() : signInWithPassword())}
            >
              {busy ? 'Working…' : recovering ? 'Set new password' : activating ? 'Activate account' : mode === 'otp' ? 'Request a code' : 'Sign in'}
            </Button>

            {!choosingPassword ? <Button
              variant="ghost"
              onClick={() => {
                setMode(mode === 'otp' ? 'password' : 'otp');
                setError(null);
              }}
            >
              {mode === 'otp' ? 'Use a password instead' : 'Use a one-time code instead'}
            </Button> : null}
          </>
        ) : (
          <>
            <div>
              <Eyebrow>Enter your code</Eyebrow>
              <p className="mt-2 text-[13px] leading-relaxed text-foam-65">
                {challenge?.delivery === 'development_echo'
                  ? `Local development mode exposed a code for ${challenge.destination}; no message was sent.`
                  : `A sign-in code was submitted to ${challenge?.destination}. It is good for ten minutes.`}
              </p>
            </div>

            <Field
              label="Six-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              className="[&_input]:text-center [&_input]:font-display [&_input]:text-[30px] [&_input]:tracking-[0.4em]"
            />

            {challenge?.delivery === 'development_echo' ? (
              <Panel className="p-3">
                <p className="text-[12px] leading-relaxed text-foam-50">
                  The development code is shown in the field above. Production never returns it.
                </p>
              </Panel>
            ) : null}

            {error ? (
              <Panel tone="bad" className="p-3">
                <p className="text-[13px] leading-relaxed text-foam-80">{error}</p>
              </Panel>
            ) : null}

            <Button variant="cta" size="lg" full disabled={busy || code.length !== 6} onClick={() => void verifyOtp()}>
              {busy ? 'Checking…' : 'Sign in'}
            </Button>

            <Button
              variant="ghost"
              onClick={() => {
                setStep('identify');
                setError(null);
              }}
            >
              Use a different address
            </Button>
          </>
        )}

        {import.meta.env.DEV && !activating ? <Panel className="mt-auto p-3.5">
          <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
            Demo accounts
          </span>
          <div className="mt-2 flex flex-col gap-1.5 text-[12px] leading-relaxed text-foam-65">
            <button
              type="button"
              className="text-left hover:text-sonar"
              onClick={() => {
                setIdentifier('aman@sharkfitness.in');
                setMode('otp');
                setStep('identify');
              }}
            >
              <span className="text-foam">aman@sharkfitness.in</span> — member, active, mid-block
            </button>
            <button
              type="button"
              className="text-left hover:text-sonar"
              onClick={() => {
                setIdentifier('rohit@sharkfitness.in');
                setMode('otp');
                setStep('identify');
              }}
            >
              <span className="text-foam">rohit@sharkfitness.in</span> — grace period, failed payment
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-foam-35">
            Password sign-in for both is <span className="text-foam-50">shark1234</span>. Staff use the dashboard.
          </p>
        </Panel> : null}
      </div>
    </div>
  );
}
