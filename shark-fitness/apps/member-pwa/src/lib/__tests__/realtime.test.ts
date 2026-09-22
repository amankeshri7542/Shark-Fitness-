import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Viewer } from '@shark/contracts';
import { cleanup, renderHook } from '@testing-library/react';

vi.mock('../api', () => ({ api: vi.fn(), API_ORIGIN: '', auth: { get: () => 'cookie-session', clear: vi.fn() } }));
vi.mock('../outbox', () => ({ startOutbox: vi.fn(() => vi.fn()), stopOutbox: vi.fn() }));
import { api } from '../api';
import { useSession } from '../store';
import { connectRealtime, disconnectRealtime, useMemberConnection } from '../realtime';
import { startOutbox } from '../outbox';

class Socket extends EventTarget {
  static latest: Socket;
  constructor() { super(); Socket.latest = this; }
  send() {}
  close() { this.dispatchEvent(new Event('close')); }
}
const viewer = { userId: 'member-a', tenantId: 'gym', role: 'member', name: 'Original' } as Viewer;
afterEach(() => { cleanup(); disconnectRealtime(); vi.unstubAllGlobals(); vi.clearAllMocks(); useSession.getState().setViewer(null); });

it('keeps one connection across profile updates, and reconnects only for changed access or account identity', async () => {
  vi.stubGlobal('WebSocket', Socket);
  vi.mocked(api).mockResolvedValue({ ticket: 'synthetic' } as never);
  const current = { ...viewer, memberId: 'member', permittedBranchIds: ['main'] };
  const client = new QueryClient();
  const { rerender } = renderHook(({ value }) => useMemberConnection(value, client), { initialProps: { value: current as Viewer | null } });
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  rerender({ value: { ...current, name: 'Corrected', permittedBranchIds: ['main'] } });
  expect(api).toHaveBeenCalledTimes(1);
  expect(startOutbox).toHaveBeenCalledTimes(1);
  rerender({ value: { ...current, permittedBranchIds: ['main', 'second'] } });
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  rerender({ value: { ...current, userId: 'member-b' } });
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  rerender({ value: null });
  expect(api).toHaveBeenCalledTimes(3);
});

it('refreshes the current profile but never restores a viewer after sign-out, account switch or disconnect', async () => {
  vi.stubGlobal('WebSocket', Socket);
  let resolveProfile: (value: { viewer: Viewer }) => void = () => {};
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/me/realtime-ticket') return { ticket: 'synthetic' } as never;
    return new Promise((resolve) => { resolveProfile = resolve; });
  });
  useSession.getState().setViewer(viewer);
  connectRealtime(new QueryClient(), ['member:member-a']);
  await vi.waitFor(() => expect(Socket.latest).toBeDefined());
  const event = () => Socket.latest.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', topic: 'member.profile_updated', seq: 1, payload: {} }) }));
  event();
  resolveProfile({ viewer: { ...viewer, name: 'Corrected' } });
  await vi.waitFor(() => expect(useSession.getState().viewer?.name).toBe('Corrected'));
  event();
  useSession.getState().setViewer(null);
  resolveProfile({ viewer });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useSession.getState().status).toBe('signed-out');
  useSession.getState().setViewer(viewer);
  event();
  const other = { ...viewer, userId: 'member-b', name: 'Other' };
  useSession.getState().setViewer(other);
  resolveProfile({ viewer });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useSession.getState().viewer).toEqual(other);
  useSession.getState().setViewer(viewer);
  event();
  disconnectRealtime();
  resolveProfile({ viewer: { ...viewer, name: 'Old connection' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useSession.getState().viewer?.name).toBe('Original');
});
