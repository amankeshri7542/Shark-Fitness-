import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '../../lib/api';
import EquipmentScreen from '../Equipment';
import { refuse, renderScreen, setOnline, signInAs } from '../../test/harness';

/* Equipment and facility operations (PF-FAC). Fixture follows `facilityView`
   in apps/api/src/services/facility.ts. */

const treadmill = {
  id: 'eq_1',
  name: 'Treadmill 3',
  assetTag: 'KOR-003',
  qrIdentifier: 'KOR-003',
  branchId: 'br_kor',
  branchName: 'Koramangala',
  area: 'Cardio deck',
  model: 'Technogym Run 700',
  serial: 'TG-77812',
  vendor: 'Technogym',
  warrantyUntil: '2027-03-01',
  status: 'available',
  lastServicedOn: '2026-10-01',
  serviceIntervalDays: 90,
  nextServiceDue: '2026-12-30',
  overdue: false,
  openWorkOrders: 0,
  downtimeDays30: 0,
  outOfService: false,
  safetyHold: false,
  returnBlockedReason: null,
};

const rack = {
  ...treadmill,
  id: 'eq_2',
  name: 'Squat rack 1',
  assetTag: 'KOR-011',
  qrIdentifier: 'KOR-011',
  area: 'Strength floor',
  model: 'Rogue SML-2',
  serial: 'RG-1102',
  status: 'out_of_service',
  outOfService: true,
  openWorkOrders: 1,
  returnBlockedReason: null,
};

const workOrder = {
  id: 'wo_1',
  reference: 'WO-0042',
  equipmentId: 'eq_2',
  equipmentName: 'Squat rack 1',
  branchId: 'br_kor',
  branchName: 'Koramangala',
  title: 'J-hook cracked',
  description: 'Left J-hook has a hairline crack.',
  severity: 'high',
  state: 'open',
  reportedByName: 'Priya Rao',
  reportedByKind: 'staff',
  assigneeId: null,
  assigneeName: null,
  costMinor: 0,
  openedAt: '2026-11-24T05:00:00.000Z',
  closedAt: null,
  duplicateOfId: null,
  restricted: false,
  overdue: false,
  needsReassignment: false,
};

const task = {
  id: 'ft_1',
  branchId: 'br_kor',
  branchName: 'Koramangala',
  title: 'Opening checks',
  cadence: 'daily',
  nextDueAt: '2026-11-27T00:30:00.000Z',
  branchState: 'open',
  overdue: false,
  assigneeId: null,
  assigneeName: null,
  state: 'open',
  checklist: ['Floor walk', 'Sanitiser stations'],
  lastCompletedAt: null,
};

const metrics = {
  equipmentTotal: 2,
  available: 1,
  inMaintenance: 0,
  outOfService: 1,
  retired: 0,
  overdueMaintenance: 0,
  openWorkOrders: 1,
  safetyIssues: 0,
  recurringFaults: 0,
  maintenanceCostMinor: 0,
  maintenanceCost30dMinor: 250_000,
  downtimeDays30: 2,
  completedWorkOrders: 3,
  workOrderCompletionPct: 75,
  totalTasks: 4,
  completedTasks: 3,
  taskCompletionPct: 75,
};

const full = { metrics, equipment: [treadmill, rack], workOrders: [workOrder], tasks: [task] };
const empty = {
  metrics: { ...metrics, equipmentTotal: 0, available: 0, outOfService: 0, openWorkOrders: 0, downtimeDays30: 0, maintenanceCost30dMinor: 0, totalTasks: 0, completedTasks: 0, taskCompletionPct: 0 },
  equipment: [],
  workOrders: [],
  tasks: [],
};

const screens = [{ path: '/equipment', component: EquipmentScreen }];

beforeEach(() => {
  apiMock.mockReset();
  setOnline(true);
  signInAs('branch_manager');
});
afterEach(() => setOnline(true));

describe('Equipment', () => {
  it('shows a permission state, and reads nothing, for a role without facility access', async () => {
    signInAs('reception');
    renderScreen('/equipment', screens);
    expect(await screen.findByText('Not available to your role')).toBeInTheDocument();
    expect(screen.getByText(/Equipment and facility operations is restricted/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows a loading page, then the registry', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    apiMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderScreen('/equipment', screens);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith('/admin/facility?limit=250', { branchId: 'br_kor' });
    resolve(full);
    expect(await screen.findByText('Treadmill 3')).toBeInTheDocument();
    expect(screen.getByText('Koramangala · 2 assets')).toBeInTheDocument();
  });

  it('says the facility could not be read, with the server reason, and retries', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementationOnce(() =>
      refuse(new ApiError(503, { error: { code: 'UNAVAILABLE', message: 'Facility records are being migrated.', requestId: 'req_1' } })),
    );
    renderScreen('/equipment', screens);
    expect(await screen.findByRole('heading', { name: 'Could not load facility operations' })).toBeInTheDocument();
    expect(screen.getByText('Facility records are being migrated.')).toBeInTheDocument();
    apiMock.mockResolvedValue(full);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Treadmill 3')).toBeInTheDocument();
  });

  it('says it is offline when the read failed without a connection', async () => {
    setOnline(false);
    apiMock.mockImplementation(() => refuse(new Error('Failed to fetch')));
    renderScreen('/equipment', screens);
    expect(await screen.findByText('This machine is offline. Reconnect to read facility operations.')).toBeInTheDocument();
  });

  it('says each list is empty and offers the first action to a manager', async () => {
    apiMock.mockResolvedValue(empty);
    renderScreen('/equipment', screens);
    expect(await screen.findByRole('heading', { name: 'No equipment in this view' })).toBeInTheDocument();
    expect(screen.getByText('Add the first asset to start the registry.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No work orders' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No facility tasks' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add equipment' }).length).toBeGreaterThan(0);
  });

  it('shows the registry, open work and tasks', async () => {
    apiMock.mockResolvedValue(full);
    renderScreen('/equipment', screens);
    const registry = await screen.findByRole('region', { name: 'Equipment registry · 2' });
    expect(within(registry).getByText('Technogym Run 700 · TG-77812')).toBeInTheDocument();
    expect(within(registry).getByText('out of service')).toBeInTheDocument();
    expect(within(registry).getByRole('button', { name: 'Return to service' })).toBeEnabled();
    expect(screen.getByText('₹2,500')).toBeInTheDocument();
    expect(screen.getByText('3/4 tasks')).toBeInTheDocument();

    const orders = screen.getByRole('region', { name: 'Work orders · 1' });
    expect(within(orders).getByText('J-hook cracked')).toBeInTheDocument();
    expect(within(orders).getByText(/WO-0042 · Koramangala · Squat rack 1/)).toBeInTheDocument();

    const tasks = screen.getByRole('region', { name: 'Facility tasks · 1' });
    expect(within(tasks).getByText('Floor walk')).toBeInTheDocument();
  });

  it('lets a trainer read the floor but not change it', async () => {
    signInAs('trainer');
    apiMock.mockResolvedValue(full);
    renderScreen('/equipment', screens);
    expect(await screen.findByText('Treadmill 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add equipment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close work order' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete task' })).toBeNull();
    expect(screen.getByText('A manager must return this asset to service.')).toBeInTheDocument();
  });

  it('keeps the search box while the filtered list loads', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => Promise.resolve(path.includes('q=') ? { ...full, equipment: [treadmill] } : full));
    renderScreen('/equipment', screens);
    await screen.findByText('Squat rack 1');
    await user.type(screen.getByLabelText('Search'), 'tread');
    expect(screen.getByLabelText('Search')).toHaveValue('tread');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/admin/facility?limit=250&q=tread', { branchId: 'br_kor' }));
    await waitFor(() => expect(screen.queryByText('Squat rack 1')).toBeNull());
    expect(screen.getByText('Treadmill 3')).toBeInTheDocument();
  });

  it('closes a work order with a resolution note', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string) => Promise.resolve(path.startsWith('/admin/facility?') ? full : { ok: true }));
    renderScreen('/equipment', screens);
    const orders = await screen.findByRole('region', { name: 'Work orders · 1' });
    const close = within(orders).getByRole('button', { name: 'Close work order' });
    expect(close).toBeDisabled();
    await user.type(within(orders).getByLabelText('Resolution note'), 'Replaced the J-hook and load-tested.');
    await user.click(close);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/admin/facility/work-orders/wo_1', {
        method: 'PATCH',
        body: { state: 'done', resolutionNote: 'Replaced the J-hook and load-tested.' },
      }),
    );
  });

  it('holds every change while offline', async () => {
    setOnline(false);
    apiMock.mockResolvedValue(full);
    renderScreen('/equipment', screens);
    expect(await screen.findByText('You are offline. Facility data is read-only until the connection returns.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add equipment' })[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete task' })).toBeDisabled();
  });
});
