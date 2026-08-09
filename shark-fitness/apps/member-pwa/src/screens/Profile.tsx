import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';
import { ApiError, api } from '../lib/api';
import { useViewer } from '../lib/store';
import { ScreenBody, Stack } from '../ui/shell';
import {
  Button,
  Chip,
  Display,
  ErrorState,
  Label,
  Panel,
  SectionRule,
  Segmented,
  Skeleton,
} from '../ui/primitives';

/**
 * Profile, preferences, privacy and devices.
 *
 * Privacy copy is plain register throughout — consent, export and deletion are
 * exactly the surfaces where the predator voice would be wrong. Each control
 * states what it does before it is used, and the destructive one states what
 * survives it.
 */

interface Consent {
  purpose: string;
  granted: boolean;
  required: boolean;
  description: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  userAgent: string;
  ip: string;
  current: boolean;
  lastSeenLabel?: string;
  createdAt?: string;
}

export default function ProfileScreen() {
  const viewer = useViewer();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const consents = useQuery({
    queryKey: ['consents'],
    queryFn: () => api<{ items: Consent[] }>('/me/consents'),
  });

  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ items: SessionRow[] }>('/me/sessions'),
  });

  const fail = (err: unknown): void =>
    setError(err instanceof ApiError ? err.message : 'That did not go through. Nothing has changed.');

  const savePreferences = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<{ viewer: Viewer }>('/me/preferences', { method: 'PATCH', body: patch }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['viewer'] });
      // The register and unit system change copy across every screen.
      void queryClient.invalidateQueries();
    },
    onError: fail,
  });

  const setConsent = useMutation({
    mutationFn: (input: { purpose: string; granted: boolean }) =>
      api('/me/consents', { method: 'PUT', body: input }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['consents'] });
    },
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: (sessionId: string) => api(`/me/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setError(null);
      setMessage('That device has been signed out.');
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: fail,
  });

  const exportData = useMutation({
    mutationFn: () => api<{ message: string }>('/me/data-export', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      setError(null);
      setMessage(r.message);
    },
    onError: fail,
  });

  const requestDeletion = useMutation({
    mutationFn: () => api<{ message: string }>('/me/deletion-request', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      setError(null);
      setConfirmDelete(false);
      setMessage(r.message);
    },
    onError: fail,
  });

  if (!viewer) {
    return (
      <ScreenBody>
        <Stack>
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </Stack>
      </ScreenBody>
    );
  }

  const prefs = viewer.preferences;

  return (
    <ScreenBody>
      <Stack>
        {message ? (
          <Panel tone="good" className="p-4">
            <p className="text-[13px] leading-relaxed">{message}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setMessage(null)}>
              Dismiss
            </Button>
          </Panel>
        ) : null}

        {error ? (
          <Panel tone="bad" className="p-4">
            <p className="text-[13px] leading-relaxed">{error}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </Panel>
        ) : null}

        {/* — Identity ————————————————————————————————————————— */}

        <Panel className="flex items-center gap-3 p-4">
          <span className="grid h-12 w-12 flex-none place-items-center border border-line-strong font-display text-[16px]">
            {viewer.initials}
          </span>
          <div className="min-w-0 flex-1">
            <Display size="sm" as="h2">
              {viewer.name}
            </Display>
            <p className="mt-1 truncate text-[12px] text-foam-50">{viewer.email ?? 'No email on file'}</p>
          </div>
          <Chip tone={viewer.accountState === 'active' ? 'good' : 'warn'}>{viewer.accountState.replace(/_/g, ' ')}</Chip>
        </Panel>

        {/* — Preferences ——————————————————————————————————————— */}

        <div>
          <SectionRule>How the app speaks</SectionRule>
          <Panel className="flex flex-col gap-4 p-4">
            <div>
              <Label>Tone</Label>
              <div className="mt-2">
                <Segmented
                  value={prefs.register}
                  onChange={(register) => savePreferences.mutate({ register })}
                  options={[
                    { value: 'predator', label: 'Predator' },
                    { value: 'plain', label: 'Plain' },
                  ]}
                />
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-foam-50">
                Predator is the training-floor voice. Anything about money, access or your health always stays plain,
                whichever you pick.
              </p>
            </div>

            <div>
              <Label>Units</Label>
              <div className="mt-2">
                <Segmented
                  value={prefs.unitSystem}
                  onChange={(unitSystem) => savePreferences.mutate({ unitSystem })}
                  options={[
                    { value: 'metric', label: 'kg' },
                    { value: 'imperial', label: 'lb' },
                  ]}
                />
              </div>
            </div>

            <div>
              <Label>Theme</Label>
              <div className="mt-2">
                <Segmented
                  value={prefs.theme}
                  onChange={(theme) => savePreferences.mutate({ theme })}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'Auto' },
                  ]}
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <ToggleRow
                label="Haptics"
                hint="A short tap when a set is logged."
                checked={prefs.haptics}
                onChange={(haptics) => savePreferences.mutate({ haptics })}
              />
              <ToggleRow
                label="Reduce motion"
                hint="Turns off sweeps and transitions. Nothing essential is animation-only."
                checked={prefs.reducedMotion}
                onChange={(reducedMotion) => savePreferences.mutate({ reducedMotion })}
              />
            </div>
          </Panel>
        </div>

        {/* — Consent ——————————————————————————————————————————— */}

        <div>
          <SectionRule>Your data</SectionRule>
          {consents.isLoading ? (
            <Skeleton className="h-40" />
          ) : consents.error || !consents.data ? (
            <ErrorState
              title="Could not load your permissions"
              body="Your settings are unchanged. Try again in a moment."
              onRetry={() => void consents.refetch()}
            />
          ) : (
            <Panel className="flex flex-col gap-3 p-4">
              {consents.data.items.map((consent) => (
                <ToggleRow
                  key={consent.purpose}
                  label={consent.description}
                  hint={consent.required ? 'Required to hold a membership.' : undefined}
                  checked={consent.granted}
                  disabled={consent.required || setConsent.isPending}
                  onChange={(granted) => setConsent.mutate({ purpose: consent.purpose, granted })}
                />
              ))}
            </Panel>
          )}
        </div>

        {/* — Devices ——————————————————————————————————————————— */}

        <div>
          <SectionRule>Signed-in devices</SectionRule>
          {sessions.isLoading ? (
            <Skeleton className="h-24" />
          ) : sessions.error || !sessions.data ? (
            <ErrorState
              title="Could not load your devices"
              body="You are still signed in here. Try again in a moment."
              onRetry={() => void sessions.refetch()}
            />
          ) : (
            <Panel className="flex flex-col gap-2 p-4">
              {sessions.data.items.map((row) => (
                <div key={row.id} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{row.userAgent || 'Unknown device'}</p>
                    <p className="mt-0.5 font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35">{row.ip}</p>
                  </div>
                  {row.current ? (
                    <Chip tone="accent">This device</Chip>
                  ) : (
                    <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(row.id)}>
                      Sign out
                    </Button>
                  )}
                </div>
              ))}
            </Panel>
          )}
        </div>

        {/* — Rights ————————————————————————————————————————————— */}

        <div>
          <SectionRule>Export and deletion</SectionRule>
          <Panel className="flex flex-col gap-3 p-4">
            <div>
              <Button variant="outline" disabled={exportData.isPending} onClick={() => exportData.mutate()}>
                Request a copy of my data
              </Button>
              <p className="mt-2 text-[12px] leading-relaxed text-foam-50">
                Everything we hold about you, as a file. It usually takes a few hours.
              </p>
            </div>

            {confirmDelete ? (
              <Panel tone="bad" className="flex flex-col gap-3 p-4">
                <Display size="sm" as="h3">
                  Delete your account
                </Display>
                <p className="text-[13px] leading-relaxed text-foam-65">
                  Your profile, workouts and messages are removed within 30 days. Payment and safety records that the
                  law requires us to keep are retained. You can cancel this at any point before it completes.
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="danger" disabled={requestDeletion.isPending} onClick={() => requestDeletion.mutate()}>
                    Request deletion
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                    Keep my account
                  </Button>
                </div>
              </Panel>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete my account
              </Button>
            )}
          </Panel>
        </div>
      </Stack>
    </ScreenBody>
  );
}

/** A labelled switch with a real checkbox behind it, so it is reachable by
 *  keyboard and announced correctly. */
function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        className="h-5 w-5 flex-none accent-[var(--sf-sonar)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{label}</span>
        {hint ? <span className="mt-0.5 block text-[12px] leading-relaxed text-foam-50">{hint}</span> : null}
      </span>
    </label>
  );
}
