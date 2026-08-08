import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Viewer } from '@shark/contracts';
import { ApiError, OfflineError, api } from '../lib/api';
import { useAdmin } from '../lib/store';
import { Button, Display, Field } from '../ui/console';

const TENANT_SLUG = 'shark';

const DEMO_STAFF = [
  { email: 'owner@sharkfitness.in', role: 'Owner', sees: 'Everything except platform administration' },
  { email: 'manager@sharkfitness.in', role: 'Branch manager', sees: 'Koramangala operations, no refunds' },
  { email: 'reception@sharkfitness.in', role: 'Reception', sees: 'Six modules — the desk’s job, nothing else' },
  { email: 'rehan@sharkfitness.in', role: 'Trainer', sees: 'Their own members and programmes only' },
  { email: 'accounts@sharkfitness.in', role: 'Accountant', sees: 'Money and reports, no schedule' },
];

export default function SignInScreen() {
  const navigate = useNavigate();
  const bootstrap = useAdmin((state) => state.bootstrap);
  const [email, setEmail] = useState('owner@sharkfitness.in');
  const [password, setPassword] = useState('shark1234');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ viewer: Viewer; csrfToken: string }>('/auth/password', {
        method: 'POST',
        body: { tenantSlug: TENANT_SLUG, email, password },
      });
      if (result.viewer.role === 'member') {
        await api('/auth/sign-out', { method: 'POST' });
        setError('That is a member account. The dashboard is for gym staff — members use the app.');
        return;
      }
      await bootstrap();
      await navigate({ to: '/' });
    } catch (err) {
      if (err instanceof OfflineError) setError('No connection to the API. Is it running on :8787?');
      else if (err instanceof ApiError) setError(err.message);
      else setError('That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-dvh place-items-center p-6">
      <div className="w-[min(880px,100%)] border border-line">
        <div className="grid grid-cols-1 md:grid-cols-2">
          <div
            className="relative overflow-hidden border-b border-line p-8 md:border-b-0 md:border-r"
            style={{
              background:
                'linear-gradient(180deg, var(--sf-shelf-top) 0%, var(--sf-shelf-mid) 55%, var(--sf-abyss) 100%)',
            }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-[0.16]"
              style={{
                background: 'repeating-linear-gradient(180deg, rgba(120,190,215,.5) 0 1px, transparent 1px 26px)',
              }}
            />
            <div className="relative">
              <div className="flex items-center gap-2.5">
                <span className="font-display text-[22px] uppercase leading-none tracking-[0.06em]">Shark</span>
                <span
                  aria-hidden="true"
                  className="h-1 w-5"
                  style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
                />
                <span className="font-utility text-[10px] uppercase tracking-[0.18em] text-foam-35">Operations</span>
              </div>
              <Display size="lg" className="mt-8">
                Run the
                <br />
                <span className="text-sonar">whole floor</span>
              </Display>
              <p className="mt-4 max-w-[34ch] text-[13px] leading-relaxed text-foam-65">
                Members, memberships, money, the door, the schedule and the kit — one console, scoped to what your
                role actually needs.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4 p-8">
            <Field
              label="Work email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void signIn();
              }}
            />

            {error ? (
              <div className="border border-chum bg-wash-chum p-3">
                <p className="text-[13px] leading-relaxed">{error}</p>
              </div>
            ) : null}

            <Button variant="cta" size="md" full disabled={busy} onClick={() => void signIn()}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>

            <div className="mt-2 border-t border-line pt-3">
              <span className="font-utility text-[10px] font-semibold uppercase tracking-[0.14em] text-foam-45">
                Demo roles — the console changes shape for each
              </span>
              <ul className="mt-2 flex flex-col gap-1.5">
                {DEMO_STAFF.map((staff) => (
                  <li key={staff.email}>
                    <button
                      type="button"
                      className="w-full text-left text-[12px] leading-snug text-foam-65 hover:text-sonar"
                      onClick={() => setEmail(staff.email)}
                    >
                      <span className="text-foam">{staff.role}</span> — {staff.sees}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-foam-35">Password for all: shark1234</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
