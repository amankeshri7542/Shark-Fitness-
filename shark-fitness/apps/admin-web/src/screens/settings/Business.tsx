import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BusinessProfile, Consequence } from '@shark/contracts';
import { ApiError, api } from '../../lib/api';
import { ErrorState, Field, SelectField, Skeleton } from '../../ui/console';
import { ConsequenceDialog, SettingsSection, consequencesOf, useDraft } from './shared';

type Profile = BusinessProfile & { slug: string; plan: string; status: string };

/**
 * The company, as it appears on an invoice.
 *
 * Split into three sections that commit separately, because they fail
 * separately: a typo in the legal name is a correction, and a currency change
 * is a decision with an audit trail and a dialog in front of it. One Save at
 * the bottom would have made the second the price of the first.
 */
export default function Business({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['settings', 'business'],
    queryFn: () => api<Profile>('/admin/settings/business'),
    enabled: canManage,
  });

  const identity = useDraft(profile.data);
  const [tax, setTax] = useState<Profile['taxProfile'] | undefined>(undefined);
  const [taxDirty, setTaxDirty] = useState(false);
  const [pendingChange, setPendingChange] = useState<{ patch: Record<string, unknown>; consequences: Consequence[] } | null>(null);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<Profile>('/admin/settings/business', { method: 'PATCH', body: patch }),
    onSuccess: (next) => {
      queryClient.setQueryData(['settings', 'business'], next);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      identity.reset();
      setTaxDirty(false);
      setTax(undefined);
      setPendingChange(null);
    },
    onError: (error, patch) => {
      const consequences = consequencesOf(error);
      // A 409 with consequences is a question, not a failure. Anything else is
      // a failure and stays on the section that caused it.
      if (consequences.length > 0) setPendingChange({ patch, consequences });
    },
  });

  if (!canManage) return null;
  if (profile.isLoading) return <Skeleton className="h-64" />;
  if (profile.error || !profile.data || !identity.draft) {
    return (
      <ErrorState
        title="Settings could not be read"
        body={profile.error instanceof ApiError ? profile.error.message : 'The server did not answer.'}
        onRetry={() => void profile.refetch()}
      />
    );
  }

  const draft = identity.draft;
  const taxDraft = tax ?? draft.taxProfile ?? {
    registrationNumber: '', label: 'GST', defaultRateBp: 0, pricesIncludeTax: true,
  };
  const errorFor = (section: 'identity' | 'tax'): string | null => {
    if (!save.isError || pendingChange) return null;
    if (save.variables && ('taxProfile' in save.variables) !== (section === 'tax')) return null;
    return save.error instanceof ApiError ? save.error.message : 'That could not be saved.';
  };

  return (
    <>
      <SettingsSection
        title="Identity"
        description="The name on your invoices and the name your members see. They are often not the same."
        dirty={identity.dirty}
        pending={save.isPending && !('taxProfile' in (save.variables ?? {}))}
        error={errorFor('identity')}
        onReset={identity.reset}
        onSave={() =>
          save.mutate({
            legalName: draft.legalName,
            displayName: draft.displayName,
            locale: draft.locale,
            unitSystem: draft.unitSystem,
            currency: draft.currency,
            timezone: draft.timezone,
          })
        }
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Field
            label="Legal name"
            hint="As registered. This is what appears on an invoice."
            value={draft.legalName}
            onChange={(e) => identity.set({ legalName: e.target.value })}
          />
          <Field
            label="Display name"
            hint="What members see in the app and in messages."
            value={draft.displayName}
            onChange={(e) => identity.set({ displayName: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Field
            label="Currency"
            hint="Applies to what you raise next. Nothing already invoiced is re-priced."
            value={draft.currency}
            maxLength={3}
            onChange={(e) => identity.set({ currency: e.target.value.toUpperCase() })}
          />
          <SelectField
            label="Units"
            hint="Weights and distances across both apps."
            value={draft.unitSystem}
            onChange={(e) => identity.set({ unitSystem: e.target.value as 'metric' })}
            options={[
              { value: 'metric', label: 'Metric — kg, km' },
              { value: 'imperial', label: 'Imperial — lb, mi' },
            ]}
          />
          <Field
            label="Locale"
            hint="Number and date formatting, e.g. en-IN."
            value={draft.locale}
            onChange={(e) => identity.set({ locale: e.target.value })}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Tax"
        description="Printed on every invoice from the moment you save it. Invoices already raised keep the details they were raised with."
        dirty={taxDirty}
        pending={save.isPending && 'taxProfile' in (save.variables ?? {})}
        error={errorFor('tax')}
        onReset={() => {
          setTax(undefined);
          setTaxDirty(false);
        }}
        onSave={() => save.mutate({ taxProfile: taxDraft })}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Field
            label="Registration number"
            hint="GSTIN, VAT number — whatever your jurisdiction issues."
            value={taxDraft.registrationNumber}
            onChange={(e) => {
              setTax({ ...taxDraft, registrationNumber: e.target.value });
              setTaxDirty(true);
            }}
          />
          <Field
            label="What tax is called"
            hint="The word printed on the invoice line: GST, VAT, Sales tax."
            value={taxDraft.label}
            onChange={(e) => {
              setTax({ ...taxDraft, label: e.target.value });
              setTaxDirty(true);
            }}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Field
            label="Default rate (%)"
            type="number"
            min={0}
            max={100}
            step="0.01"
            hint="Products can override this. Used where one does not."
            value={taxDraft.defaultRateBp / 100}
            onChange={(e) => {
              setTax({ ...taxDraft, defaultRateBp: Math.round(Number(e.target.value) * 100) });
              setTaxDirty(true);
            }}
          />
          <SelectField
            label="Prices include tax"
            hint="Off means tax is added at checkout rather than already inside the price."
            value={taxDraft.pricesIncludeTax ? 'yes' : 'no'}
            onChange={(e) => {
              setTax({ ...taxDraft, pricesIncludeTax: e.target.value === 'yes' });
              setTaxDirty(true);
            }}
            options={[
              { value: 'yes', label: 'Yes — catalogue prices are what a member pays' },
              { value: 'no', label: 'No — tax is added at checkout' },
            ]}
          />
        </div>
      </SettingsSection>

      <ConsequenceDialog
        open={pendingChange !== null}
        title="This changes how existing records read"
        intent="Apply anyway"
        consequences={pendingChange?.consequences ?? []}
        pending={save.isPending}
        onCancel={() => setPendingChange(null)}
        onConfirm={(acknowledge) => {
          if (pendingChange) save.mutate({ ...pendingChange.patch, acknowledge });
        }}
      />
    </>
  );
}
