import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BusinessProfile } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import { ErrorState, Field, Skeleton } from '../../ui/console';
import { SettingsSection } from './shared';

type Profile = BusinessProfile & { slug: string; plan: string; status: string };

/**
 * Data processing (PF-TEN-001).
 *
 * Four fields, and every one of them is a promise to a person rather than a
 * switch. The retention window decides when a departed member's record is
 * anonymised; the contact is where a subject-access request lands; the consent
 * version is what a member agreed to, which is why raising it here does not
 * re-consent anybody — each consent row stores the version it was granted
 * under.
 */
export default function Privacy({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['settings', 'business'],
    queryFn: () => api<Profile>('/admin/settings/business'),
    enabled: canManage,
  });

  const [draft, setDraft] = useState<Profile['dataProcessing'] | undefined>(undefined);
  const [dirty, setDirty] = useState(false);

  const save = useMutation({
    mutationFn: (dataProcessing: Profile['dataProcessing']) =>
      api<Profile>('/admin/settings/business', { method: 'PATCH', body: { dataProcessing } }),
    onSuccess: (next) => {
      queryClient.setQueryData(['settings', 'business'], next);
      void queryClient.invalidateQueries({ queryKey: ['settings', 'setup'] });
      setDraft(undefined);
      setDirty(false);
    },
  });

  if (!canManage) return null;
  if (profile.isLoading) return <Skeleton className="h-64" />;
  if (profile.error || !profile.data) {
    return (
      <ErrorState
        title="Settings could not be read"
        body={profile.error instanceof ApiError ? profile.error.message : 'The server did not answer.'}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const value = draft ??
    profile.data.dataProcessing ?? {
      privacyContact: '',
      retentionDays: 1095,
      consentVersion: '',
      jurisdiction: '',
    };
  const edit = (patch: Partial<NonNullable<Profile['dataProcessing']>>): void => {
    setDraft({ ...value, ...patch });
    setDirty(true);
  };

  return (
    <SettingsSection
      title="Data processing"
      description="Who a member writes to about their data, how long you keep it, and which version of your terms is in force."
      dirty={dirty}
      pending={save.isPending}
      error={save.isError ? (save.error instanceof ApiError ? save.error.message : 'That could not be saved.') : null}
      onReset={() => {
        setDraft(undefined);
        setDirty(false);
      }}
      onSave={() => save.mutate(value)}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field
          label="Privacy contact"
          hint="Where a member's request to see or delete their data arrives."
          placeholder="privacy@yourgym.com"
          value={value.privacyContact}
          onChange={(e) => edit({ privacyContact: e.target.value })}
        />
        <Field
          label="Jurisdiction"
          hint="The rules you operate under. Recorded, not enforced."
          placeholder="India — DPDP Act 2023"
          value={value.jurisdiction}
          onChange={(e) => edit({ jurisdiction: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Field
          label="Retention after leaving (days)"
          type="number"
          min={30}
          max={3650}
          hint="A departed member's record is anonymised after this. Tax rules usually set a floor."
          value={value.retentionDays}
          onChange={(e) => edit({ retentionDays: Number(e.target.value) })}
        />
        <Field
          label="Consent version"
          hint="Raising this does not re-consent anyone — each member's consent records the version they agreed to."
          placeholder="2026-01"
          value={value.consentVersion}
          onChange={(e) => edit({ consentVersion: e.target.value })}
        />
      </div>
    </SettingsSection>
  );
}
