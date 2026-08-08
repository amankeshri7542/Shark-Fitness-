import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Viewer } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../lib/api';
import { useSession } from '../lib/store';
import { Button, Display, Eyebrow, Field, Panel, Scanlines, SonarSweep } from '../ui/primitives';

interface OtpStart {
  challengeId: string;
  sentTo: string;
  expiresInSec: number;
  devCode?: string;
}

interface SignInResult {
  viewer: Viewer;
  csrfToken: string;
}

const TENANT_SLUG = 'shark';

export default function SignInScreen() {
  const navigate = useNavigate();
  const bootstrap = useSession((state) => state.bootstrap);

  const [mode, setMode] = useState<'otp' | 'password'>('otp');
  const [step, setStep] = useState<'identify' | 'verify'>('identify');
  const [identifier, setIdentifier] = useState('aman@sharkfitness.in');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<OtpStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const result = await api<OtpStart>('/auth/otp/start', {
        method: 'POST',
        body: { identifier, tenantSlug: TENANT_SLUG },
      });
      setChallenge(result);
      setCode(result.devCode ?? '');
      setStep('verify');
    });

  const finish = async (): Promise<void> => {
    await bootstrap();
    await navigate({ to: '/' });
  };

  const verifyOtp = () =>
    run(async () => {
      await api<SignInResult>('/auth/otp/verify', {
        method: 'POST',
        body: { challengeId: challenge?.challengeId, code },
      });
      await finish();
    });

  const signInWithPassword = () =>
    run(async () => {
      await api<SignInResult>('/auth/password', {
        method: 'POST',
        body: { tenantSlug: TENANT_SLUG, email: identifier, password },
      });
      await finish();
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
            Your membership, your plan and your entry pass. Koramangala, Indiranagar and HSR.
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        {step === 'identify' ? (
          <>
            <Field
              label={mode === 'otp' ? 'Email or phone' : 'Email'}
              type={mode === 'otp' ? 'text' : 'email'}
              inputMode={mode === 'otp' ? 'email' : undefined}
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              hint={mode === 'otp' ? 'We will send you a six-digit code.' : undefined}
            />

            {mode === 'password' ? (
              <Field
                label="Password"
                type="password"
                autoComplete="current-password"
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
              disabled={busy || identifier.length < 3}
              onClick={() => void (mode === 'otp' ? startOtp() : signInWithPassword())}
            >
              {busy ? 'Working…' : mode === 'otp' ? 'Send my code' : 'Sign in'}
            </Button>

            <Button
              variant="ghost"
              onClick={() => {
                setMode(mode === 'otp' ? 'password' : 'otp');
                setError(null);
              }}
            >
              {mode === 'otp' ? 'Use a password instead' : 'Email me a code instead'}
            </Button>
          </>
        ) : (
          <>
            <div>
              <Eyebrow>Check your messages</Eyebrow>
              <p className="mt-2 text-[13px] leading-relaxed text-foam-65">
                We sent a six-digit code to {challenge?.sentTo}. It is good for ten minutes.
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

            {challenge?.devCode ? (
              <Panel className="p-3">
                <p className="text-[12px] leading-relaxed text-foam-50">
                  Local demo mode is explicitly echoing the code. Production never returns it.
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

        <Panel className="mt-auto p-3.5">
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
        </Panel>
      </div>
    </div>
  );
}
