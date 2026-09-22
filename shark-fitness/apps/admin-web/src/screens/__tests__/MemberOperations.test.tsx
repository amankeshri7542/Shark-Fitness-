import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({ viewer: { role: 'reception' }, branches: [{ id: 'main', name: 'Main' }], activeBranchId: 'main', allowed: true }));
vi.mock('../../lib/store', () => ({ usePermission: () => state.allowed, useAdmin: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: vi.fn() }));
import { api } from '../../lib/api';
import { MemberEditor } from '../MemberEditor';
import { RosterImport, csvReportCell } from '../RosterImport';

afterEach(() => { cleanup(); vi.clearAllMocks(); state.viewer.role = 'reception'; state.allowed = true; });
function show(children: ReactNode) { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>); }
const member = { id: 'member', name: 'Synthetic Person', firstName: 'Synthetic', lastName: 'Person', version: 3, email: 'synthetic@example.test', phone: null, dob: null, addressLine: null, emergencyContact: null };

it('reception corrects profile only, sees failed save, and cancellation discards the draft', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({} as never);
  const saved = vi.fn();
  show(<MemberEditor member={member} onSaved={saved} />);
  expect(screen.queryByRole('button', { name: 'Correct login identity' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Correct details' }));
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Corrected' } });
  fireEvent.change(screen.getByLabelText('Correction reason'), { target: { value: 'Verified name typo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(saved).not.toHaveBeenCalled();
  expect(vi.mocked(api).mock.calls[0]?.[1]?.body).toMatchObject({ version: 3, firstName: 'Corrected', reason: 'Verified name typo' });
  expect(vi.mocked(api).mock.calls[0]?.[1]?.body).not.toHaveProperty('email');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel correction' }));
  fireEvent.click(screen.getByRole('button', { name: 'Correct details' }));
  expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
  fireEvent.change(screen.getByLabelText('Correction reason'), { target: { value: 'Verified name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
});

it('owner identity correction requires verification and clears fresh authentication after failure', async () => {
  state.viewer.role = 'owner';
  vi.mocked(api).mockRejectedValue(new Error('offline'));
  show(<MemberEditor member={member} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Correct login identity' }));
  const save = screen.getByRole('button', { name: 'Save correction' });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Current owner password'), { target: { value: 'synthetic-current' } });
  fireEvent.change(screen.getByLabelText('Correction reason'), { target: { value: 'Verified new contact' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(save);
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Current owner password')).toHaveValue('');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});

it('previews before import, requires confirmation, and retains the same key after an uncertain retry', async () => {
  const rows = [{ row: 2, name: 'Synthetic Person', status: 'ready', messages: [] }];
  let attempts = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/preview')) return { headers: ['firstName', 'lastName', 'email'], rows, ready: 1, skipped: 0, rejected: 0, previewToken: 'signed-preview', expiresAt: Date.now() + 60_000 } as never;
    if (++attempts === 1) throw new Error('Connection interrupted');
    return { importId: 'import', rows: [{ ...rows[0], status: 'imported', memberNo: 'SF-1' }], imported: 1, skipped: 0, rejected: 0 } as never;
  });
  show(<RosterImport />);
  fireEvent.click(screen.getByRole('button', { name: 'Import contacts' }));
  const file = new File(['firstName,lastName,email\nSynthetic,Person,synthetic@example.test'], 'roster.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => 'firstName,lastName,email\nSynthetic,Person,synthetic@example.test' });
  fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } });
  const preview = screen.getByRole('button', { name: 'Validate and preview' });
  await waitFor(() => expect(preview).toBeEnabled());
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(preview);
  const confirm = await screen.findByRole('button', { name: 'Confirm contact import' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(confirm);
  await screen.findByRole('alert');
  fireEvent.click(confirm);
  expect(await screen.findByRole('status')).toHaveTextContent('1 imported, 0 skipped, 0 rejected');
  const commits = vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/commit'));
  expect(commits).toHaveLength(2);
  expect(commits[0]?.[1]?.idempotencyKey).toBeTruthy();
  expect(commits[0]?.[1]?.idempotencyKey).toBe(commits[1]?.[1]?.idempotencyKey);
  expect(commits[0]?.[1]?.body).toMatchObject({ confirmed: true, previewToken: 'signed-preview', branchId: 'main' });
});

it('hides roster controls without permission and neutralizes spreadsheet formula cells', () => {
  state.allowed = false;
  show(<RosterImport />);
  expect(screen.queryByText('Roster import')).not.toBeInTheDocument();
  expect(csvReportCell('  =HYPERLINK("bad")')).toBe('"\'  =HYPERLINK(""bad"")"');
  expect(csvReportCell('\t@formula')).toBe('"\'\t@formula"');
  expect(csvReportCell('Synthetic, Person')).toBe('"Synthetic, Person"');
});
