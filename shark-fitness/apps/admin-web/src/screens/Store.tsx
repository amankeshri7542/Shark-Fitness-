import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PosOrderList, StockTransferList, StoreProductList, StoreReport } from '@shark/contracts';
import { api } from '../lib/api';
import { useAdmin, useBranchScope, usePermission } from '../lib/store';
import { useOnline } from '../lib/realtime';
import { Page } from '../ui/shell';
import { Chip, ErrorState, Panel, PermissionState, Tabs } from '../ui/console';
import Register from './store/Register';
import Inventory from './store/Inventory';
import Orders from './store/Orders';
import Transfers from './store/Transfers';
import Insights, { type Window } from './store/Insights';

/* ============================================================================
   Store — point of sale and inventory (PF-POS).

   Five surfaces rather than one screen, because a shop is five jobs and they
   are not the same job. The till wants speed and nothing else in the way; a
   stocktake wants every column at once; a refund wants one receipt in detail.
   Serving all of that from a single scrolling page is what the first version
   did, and it left most of the module unreachable.

   The tabs are not numbered. These are five places to stand, not five steps to
   take, and numbering them would claim a sequence the work does not have.

   The catalogue is fetched once here and handed down. Register and Inventory
   read the same list, and fetching it twice would let the two disagree about
   how many are on the shelf.
   ========================================================================= */

const DAY = 24 * 60 * 60 * 1000;

type Section = 'register' | 'inventory' | 'orders' | 'transfers' | 'insights';

export default function StoreScreen() {
  const canView = usePermission('inventory.view');
  const canManage = usePermission('inventory.manage');
  const { branchId, branchName } = useBranchScope();
  const branches = useAdmin((s) => s.branches);
  const online = useOnline();
  const queryClient = useQueryClient();

  const [section, setSection] = useState<Section>('register');
  const [window, setWindow] = useState<Window>('30');

  const scope = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';

  const products = useQuery({
    queryKey: ['store', 'products', branchId],
    queryFn: () => api<StoreProductList>(`/admin/store/products${scope}`),
    enabled: canView,
  });
  const orders = useQuery({
    queryKey: ['store', 'orders', branchId],
    queryFn: () => api<PosOrderList>(`/admin/store/orders${scope}`),
    enabled: canView,
  });
  const transfers = useQuery({
    queryKey: ['store', 'transfers'],
    queryFn: () => api<StockTransferList>('/admin/store/transfers'),
    enabled: canView,
  });
  const report = useQuery({
    queryKey: ['store', 'reports', branchId, window],
    queryFn: () => {
      const params = new URLSearchParams({ from: String(Date.now() - Number(window) * DAY) });
      if (branchId) params.set('branchId', branchId);
      return api<StoreReport>(`/admin/store/reports?${params.toString()}`);
    },
    enabled: canView,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['store'] });
  };

  // Every hook above runs on each render; the permission gate comes after them
  // so the hook count never changes when the permission resolves.
  if (!canView) {
    return (
      <Page title="Store">
        <PermissionState what="The store" />
      </Page>
    );
  }

  const items = products.data?.items ?? [];
  const lowCount = items.filter((p) => p.lowStock && p.active).length;
  const inTransit = (transfers.data?.items ?? []).filter((t) => t.state === 'dispatched').length;

  const sections = [
    { key: 'register', label: 'Register' },
    { key: 'inventory', label: 'Inventory', ...(lowCount > 0 ? { hint: String(lowCount) } : {}) },
    { key: 'orders', label: 'Orders' },
    { key: 'transfers', label: 'Transfers', ...(inTransit > 0 ? { hint: String(inTransit) } : {}) },
    { key: 'insights', label: 'Insights' },
  ];

  return (
    <Page
      title="Store"
      kicker={branchName}
      actions={
        <div className="flex items-center gap-2">
          {lowCount > 0 ? <Chip tone="warn">{lowCount} to reorder</Chip> : null}
          {!online ? <Chip tone="bad">Offline</Chip> : null}
        </div>
      }
    >
      <Tabs label="Store sections" items={sections} active={section} onChange={(key) => setSection(key as Section)} />

      {!online ? (
        <Panel tone="warn" className="p-3">
          <p className="text-[13px] text-foam-80">
            Offline. The till cannot take a payment and nothing here will save — the stock figures
            below are the last ones this machine saw.
          </p>
        </Panel>
      ) : null}

      {products.error ? (
        <ErrorState
          title="Could not load the store"
          body="The API did not answer. Nothing has been sold and no stock has moved."
          onRetry={() => void products.refetch()}
        />
      ) : (
        <div
          role="tabpanel"
          id={`panel-${section}`}
          aria-labelledby={`tab-${section}`}
          className="flex min-h-0 flex-col"
        >
          {section === 'register' ? (
            <Register
              products={items}
              loading={products.isLoading}
              branchId={branchId}
              branchName={branchName}
              canManage={canManage}
              online={online}
            />
          ) : null}

          {section === 'inventory' ? (
            <Inventory
              products={items}
              financial={products.data?.financial}
              loading={products.isLoading}
              branchId={branchId}
              canManage={canManage}
            />
          ) : null}

          {section === 'orders' ? (
            <Orders
              orders={orders.data?.items ?? []}
              loading={orders.isLoading}
              canManage={canManage}
              online={online}
              onRefetch={refresh}
            />
          ) : null}

          {section === 'transfers' ? (
            <Transfers
              transfers={transfers.data?.items ?? []}
              products={items}
              branches={branches.map((b) => ({ id: b.id, name: b.name }))}
              loading={transfers.isLoading}
              canManage={canManage}
              onRefetch={refresh}
            />
          ) : null}

          {section === 'insights' ? (
            <Insights report={report.data} loading={report.isLoading} window={window} onWindow={setWindow} />
          ) : null}
        </div>
      )}
    </Page>
  );
}
