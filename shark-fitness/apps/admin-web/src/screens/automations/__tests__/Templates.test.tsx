import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../../lib/api';
import { refuse } from '../../../test/harness';
import { renderPanel } from '../../store/__tests__/harness';
import Templates from '../Templates';

/* The message templates (PF-COMM-003). Fixtures follow `listTemplates` in
   apps/api/src/services/automations.ts: every version is a row, and the screen
   shows the latest one per code. */

const v1 = {
  id: 'tpl_1',
  code: 'renewal.reminder',
  channel: 'in_app',
  version: 1,
  subject: 'Your membership ends soon',
  body: 'Hi {{firstName}}, your plan ends soon.',
  variables: ['firstName'],
};
const v2 = { ...v1, id: 'tpl_2', version: 2, body: 'Hi {{firstName}}, your plan ends on {{expiryDate}}.', variables: ['firstName', 'expiryDate'] };

const triggers = {
  items: [],
  triggers: [{ key: 'membership.expiring', label: 'Membership expiring', variables: ['firstName', 'expiryDate'] }],
};

function answer(templates: unknown) {
  apiMock.mockImplementation((path: string) => {
    if (path === '/admin/automations/templates') return Promise.resolve(templates);
    if (path === '/admin/automations') return Promise.resolve(triggers);
    throw new Error(`Unexpected API call: ${path}`);
  });
}

beforeEach(() => {
  apiMock.mockReset();
});

describe('Templates', () => {
  it('shows nothing but the placeholder while messages load', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockImplementation((path: string) =>
      path === '/admin/automations/templates' ? new Promise((r) => (resolve = r)) : Promise.resolve(triggers),
    );
    renderPanel(<Templates />);
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull();
    expect(screen.queryByText('No messages yet')).toBeNull();
    resolve({ items: [v1] });
    expect(await screen.findByRole('heading', { name: 'renewal.reminder' })).toBeInTheDocument();
  });

  it('says there are no messages yet and still offers to write one', async () => {
    answer({ items: [] });
    renderPanel(<Templates />);
    expect(await screen.findByRole('heading', { name: 'No messages yet' })).toBeInTheDocument();
    expect(screen.getByText('0 in use')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New message' })).toBeEnabled();
  });

  it('shows a failed read as an error, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) =>
      path === '/admin/automations/templates' ? refuse(new Error('network')) : Promise.resolve(triggers),
    );
    renderPanel(<Templates />);
    expect(await screen.findByRole('heading', { name: 'Your messages could not be read' })).toBeInTheDocument();
    expect(screen.getByText('The server did not answer.')).toBeInTheDocument();

    answer({ items: [v1] });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'renewal.reminder' })).toBeInTheDocument();
  });

  it('shows only the latest version of each message', async () => {
    answer({ items: [v1, v2] });
    renderPanel(<Templates />);
    expect(await screen.findByRole('heading', { name: 'renewal.reminder' })).toBeInTheDocument();
    expect(screen.getByText('1 in use')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.queryByText('v1')).toBeNull();
    expect(screen.getByText('Hi {{firstName}}, your plan ends on {{expiryDate}}.')).toBeInTheDocument();
    expect(screen.getByText('uses firstName, expiryDate')).toBeInTheDocument();
  });

  it('saves an edit as a new version, inserting a variable from the trigger list', async () => {
    const user = userEvent.setup();
    answer({ items: [v1] });
    renderPanel(<Templates />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { name: 'renewal.reminder · new version' })).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeDisabled();
    expect(screen.getByText(/Saving creates version 2/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'expiryDate' }));
    expect(screen.getByText('This uses firstName, expiryDate')).toBeInTheDocument();

    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/admin/automations/templates' && options?.method === 'POST') return Promise.resolve({ template: { ...v2 } });
      if (path === '/admin/automations/templates') return Promise.resolve({ items: [v1, v2] });
      return Promise.resolve(triggers);
    });
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/admin/automations/templates',
        expect.objectContaining({
          method: 'POST',
          body: { code: 'renewal.reminder', channel: 'in_app', subject: 'Your membership ends soon', body: 'Hi {{firstName}}, your plan ends soon.{{expiryDate}}' },
          idempotencyKey: expect.any(String),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'renewal.reminder · new version' })).toBeNull());
  });

  it('keeps the editor open and says why when a save is refused', async () => {
    const user = userEvent.setup();
    answer({ items: [] });
    renderPanel(<Templates />);
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const create = screen.getByRole('button', { name: 'Create message' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('Code'), 'Welcome.First');
    expect(screen.getByLabelText('Code')).toHaveValue('welcome.first');
    await user.type(screen.getByLabelText('Message'), 'Welcome aboard.');

    apiMock.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') {
        return refuse(new ApiError(409, { error: { code: 'CONFLICT', message: 'That code is already used by a WhatsApp message.', requestId: 'req_2' } }));
      }
      return Promise.resolve(path === '/admin/automations' ? triggers : { items: [] });
    });
    await user.click(create);
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is already used by a WhatsApp message.');
    expect(screen.getByRole('heading', { name: 'New message' })).toBeInTheDocument();
  });
});
