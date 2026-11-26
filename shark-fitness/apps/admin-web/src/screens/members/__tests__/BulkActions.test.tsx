import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
const downloadMock = vi.hoisted(() => vi.fn());
const saveBlobMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock, apiDownload: downloadMock, saveBlob: saveBlobMock };
});

import { refuse, signInAs } from '../../../test/harness';
import { renderPanel } from '../../store/__tests__/harness';
import { MembersBulkActions, type BulkMember } from '../BulkActions';

/* The Members bulk bar on its own. The directory-level flows (select, tag,
   assign, message, export) are in screens/__tests__/Members.test.tsx; this
   file covers what each role is offered and the states inside the drawers. */

const members: BulkMember[] = [
  { id: 'mbr_1', name: 'Asha Iyer', tags: ['vip', 'pt-client'] },
  { id: 'mbr_2', name: 'Ravi Shah', tags: ['pt-client'] },
];

function open(selection: BulkMember[] = members, onClear = vi.fn()) {
  renderPanel(<MembersBulkActions members={selection} branchId="br_kor" onClear={onClear} />);
  return { onClear };
}

beforeEach(() => {
  apiMock.mockReset();
  downloadMock.mockReset();
  saveBlobMock.mockReset();
  signInAs('branch_manager');
});

describe('BulkActions', () => {
  it('renders nothing with nothing selected', () => {
    open([]);
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers every action to a role that edits members', () => {
    open();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    for (const name of ['Add tag', 'Assign trainer', 'Message', 'Export CSV', 'Clear']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('offers only the export to a role that reports but does not edit', () => {
    signInAs('accountant');
    open();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add tag' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('offers nothing but clearing to a role without either permission', async () => {
    const user = userEvent.setup();
    signInAs('trainer');
    const { onClear } = open();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Clear']);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('shows trainers loading, then an empty branch', async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    open();
    await user.click(screen.getByRole('button', { name: 'Assign trainer' }));
    const drawer = screen.getByRole('dialog', { name: 'Assign trainer' });
    expect(within(drawer).getByText('2 members selected')).toBeInTheDocument();
    expect(within(drawer).getByText('Loading trainers…')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/admin/members/trainers', { branchId: 'br_kor' });

    resolve({ items: [] });
    expect(await within(drawer).findByText('No active trainers work at this branch.')).toBeInTheDocument();
    expect(within(drawer).queryByText('Loading trainers…')).toBeNull();
  });

  it('says the trainer list could not be read rather than showing it empty', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(() => refuse(new Error('down')));
    open();
    await user.click(screen.getByRole('button', { name: 'Assign trainer' }));
    const drawer = screen.getByRole('dialog', { name: 'Assign trainer' });
    expect(await within(drawer).findByText('Could not load trainers.')).toBeInTheDocument();
    expect(within(drawer).queryByText('No active trainers work at this branch.')).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Remove coach' })).toBeNull();
  });

  it('removes a tag already on the selection', async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ message: 'Removed “pt-client” from 2 members.' });
    const { onClear } = open();
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    const drawer = screen.getByRole('dialog', { name: 'Add tag' });
    await user.click(within(drawer).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('dialog', { name: 'Remove tag' })).toBe(drawer);
    await user.click(within(drawer).getByRole('button', { name: 'pt-client' }));
    await user.click(within(drawer).getByRole('button', { name: 'Remove tag' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Removed “pt-client” from 2 members.');
    expect(apiMock).toHaveBeenCalledWith('/admin/members/bulk/tag', {
      method: 'POST',
      body: { memberIds: ['mbr_1', 'mbr_2'], tag: 'pt-client', mode: 'remove' },
      branchId: 'br_kor',
    });
    expect(onClear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the message drawer open with the refusal when sending fails', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(() => refuse(new Error('Two of these members have opted out of messages.')));
    open();
    await user.click(screen.getByRole('button', { name: 'Message' }));
    const drawer = screen.getByRole('dialog', { name: 'Message members' });
    await user.type(within(drawer).getByLabelText('Message'), 'Pool closed Sunday.');
    expect(within(drawer).getByText(/^19\/1000\./)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Send to 2' }));
    expect(await within(drawer).findByText('Two of these members have opted out of messages.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Message members' })).toBeInTheDocument();
  });

  it('says an export failed and saves nothing', async () => {
    const user = userEvent.setup();
    downloadMock.mockImplementation(() => refuse(new Error('Export is limited to 5,000 members.')));
    open();
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Export is limited to 5,000 members.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    expect(saveBlobMock).not.toHaveBeenCalled();
  });
});
