import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PosOrderList, StockTransferList, StoreProductList, StoreReport } from '@shark/contracts';
import { api } from '../lib/api';
import { useAdmin, useBranchScope, useBranchTimeZone, usePermission } from '../lib/store';
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
   Which one is open lives in the URL, so a reload lands back at the till, a
   link to Transfers opens Transfers, and Back leaves the surface it was on.

   The catalogue is fetched once here and handed down. Register, Inventory and
   the transfer drafter read the same list, and fetching it three times would
   let them disagree about how many are on the shelf.

   What is *not* fetched on arrival is as deliberate. Opening the till used to
   pull the sales history and run the whole report — a ledger scan over every
   product at every branch in scope — before a single item was scanned. Those
   two now load when their surface opens. The catalogue and the transfer list
   stay eager: three surfaces read the catalogue, and each feeds a count in the
   tab strip that is the reason the strip is worth having.
   ========================================================================= */

const DAY = 24 * 60 * 60 * 1000;


type Section = 'register' | 'inventory' | 'orders' | 'transfers' | 'insights';

/** What a failed surface says, and which read has to succeed for it to work. */
interface SurfaceFailure {
  title: string;
  body: string;
  failed: boolean;
  retry: () => void;
}

export default function StoreScreen() {
  const canView = usePermission('inventory.view');
  const canManage = usePermission('inventory.manage');
  const { branchId, branchName } = useBranchScope();
  const timeZone = useBranchTimeZone();
  const branches = useAdmin((s) => s.branches);
  const online = useOnline();
  const queryClient = useQueryClient();

  // `useSearch` takes a route **id** — the console layout is pathless, so its
  // children are identified under it. `useNavigate` takes a **path**, which is
  // the same route without the layout segment.
  const { tab: section, window } = useSearch({ from: '/console/store' });
  const navigate = useNavigate({ from: '/store' });
  // `replace`, because flipping between five tabs is not five pages of history
  // to walk back through — Back should leave Store, not crawl the tab strip.
  const setSection = (next: Section): void => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true });
  };
  const setWindow = (next: Window): void => {
    void navigate({ search: (prev) => ({ ...prev, window: next }), replace: true });
  };

  const scope = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';

  const products = useQuery({
    queryKey: ['store', 'products', branchId],
    queryFn: () => api<StoreProductList>(`/admin/store/products${scope}`),
    enabled: canView,
  });
  const orders = useQuery({
    queryKey: ['store', 'orders', branchId],
    queryFn: () => api<PosOrderList>(`/admin/store/orders${scope}`),
    enabled: canView && section === 'orders',
  });
  const transfers = useQuery({
    queryKey: ['store', 'transfers'],
    queryFn: () => api<StockTransferList>('/admin/store/transfers'),
    enabled: canView,
  });
  const report = useQuery({
    queryKey: ['store', 'reports', branchId, window],
    queryFn: () => {
      const days = Number.parseInt(window, 10);
      const params = new URLSearchParams({ from: String(Date.now() - days * DAY) });
      if (branchId) params.set('branchId', branchId);
      return api<StoreReport>(`/admin/store/reports?${params.toString()}`);
    },
    enabled: canView && section === 'insights',
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['store'] });
  };

  /* — Failure is a state, not an absence.

     Every surface here reads a list, and "the request failed" and "there is
     nothing to show" are opposite facts that used to render identically:
     `data?.items ?? []` turned a 500 into "No sales yet" on a till that had
     taken forty that morning. The Design PRD says a permission denial SHALL
     NOT masquerade as missing data, and an error has no more business doing
     it. So each surface names the read it cannot work without, and a failure
     of that read replaces the surface with what happened and a way to retry.

     `products` covers three surfaces because all three depend on the
     catalogue: without it Register has nothing to sell, Inventory has nothing
     to count, and the transfer drafter has nothing to send. — */
  const failures: Record<Section, SurfaceFailure> = {
    register: {
      title: 'Could not open the till',
      body: 'The catalogue did not load, so nothing can be rung up. Nothing has been sold and no stock has moved.',
      failed: products.isError,
      retry: () => void products.refetch(),
    },
    inventory: {
      title: 'Could not load the catalogue',
      body: 'The product list did not load. Do not count a stocktake against this screen until it does.',
      failed: products.isError,
      retry: () => void products.refetch(),
    },
    orders: {
      title: 'Could not load the sales history',
      body: 'The API did not answer. This is not a quiet day — the sales are there and could not be read.',
      failed: orders.isError,
      retry: () => void orders.refetch(),
    },
    transfers: {
      title: 'Could not load transfers',
      body: 'The API did not answer. Stock may still be in transit; this screen cannot currently say either way.',
      failed: transfers.isError,
      retry: () => void transfers.refetch(),
    },
    insights: {
      title: 'Could not load the figures',
      body: 'The API did not answer. Nothing here is a zero — the numbers could not be read at all.',
      failed: report.isError,
      retry: () => void report.refetch(),
    },
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
  const failure = failures[section];

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

      <div
        role="tabpanel"
        id={`panel-${section}`}
        aria-labelledby={`tab-${section}`}
        className="flex min-h-0 flex-col"
      >
        {failure.failed ? (
          <ErrorState title={failure.title} body={failure.body} onRetry={failure.retry} />
        ) : (
          <>
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
                online={online}
                timeZone={timeZone}
              />
            ) : null}

            {section === 'orders' ? (
              <Orders
                orders={orders.data?.items ?? []}
                loading={orders.isPending}
                canManage={canManage}
                online={online}
                timeZone={timeZone}
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
                online={online}
                timeZone={timeZone}
                onRefetch={refresh}
              />
            ) : null}

            {section === 'insights' ? (
              <Insights
                report={report.data}
                loading={report.isPending}
                window={window}
                timeZone={timeZone}
                onWindow={setWindow}
              />
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}
