import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { CommandPalette, Rail, StatusStrip } from './ui/shell';
import { SupportBanner } from './ui/SupportBanner';
import { useAdmin } from './lib/store';

// Sign-in ships in the entry chunk so the console's first paint needs no
// second round trip; the twenty screens behind the staff gate are fetched on
// demand. Reception never downloads the platform console, and `defaultPreload:
// 'intent'` warms a chunk as soon as its rail item is hovered.
import SignInScreen from './screens/SignIn';

const CommandCenterScreen = lazyRouteComponent(() => import('./screens/CommandCenter'));
const LeadsScreen = lazyRouteComponent(() => import('./screens/Leads'));
const LeadDetailScreen = lazyRouteComponent(() => import('./screens/LeadDetail'));
const MembersScreen = lazyRouteComponent(() => import('./screens/Members'));
const MemberDetailScreen = lazyRouteComponent(() => import('./screens/MemberDetail'));
const PlansScreen = lazyRouteComponent(() => import('./screens/Plans'));
const BillingScreen = lazyRouteComponent(() => import('./screens/Billing'));
const FloorScreen = lazyRouteComponent(() => import('./screens/Floor'));
const ScheduleScreen = lazyRouteComponent(() => import('./screens/Schedule'));
const TrainingScreen = lazyRouteComponent(() => import('./screens/Training'));
const TrainingBuilderScreen = lazyRouteComponent(() => import('./screens/TrainingBuilder'));
const StaffScreen = lazyRouteComponent(() => import('./screens/Staff'));
const StaffDetailScreen = lazyRouteComponent(() => import('./screens/StaffDetail'));
const StoreScreen = lazyRouteComponent(() => import('./screens/Store'));
const EquipmentScreen = lazyRouteComponent(() => import('./screens/Equipment'));
const AutomationsScreen = lazyRouteComponent(() => import('./screens/Automations'));
const ReportsScreen = lazyRouteComponent(() => import('./screens/Reports'));
const SupportScreen = lazyRouteComponent(() => import('./screens/Support'));
const SettingsScreen = lazyRouteComponent(() => import('./screens/Settings'));
const PlatformScreen = lazyRouteComponent(() => import('./screens/Platform'));

/** Shown while a screen chunk is in flight, inside the console shell so the
 *  rail and status strip stay put instead of the pane going blank. */
function RoutePending() {
  return (
    <div className="grid h-full place-items-center">
      <span
        aria-hidden="true"
        className="h-1 w-10"
        style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
      />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function ConsoleLayout() {
  return (
    // The support banner sits above the console grid rather than inside it, so
    // it cannot be scrolled away and does not compete with the rail for space.
    <div className="flex h-dvh flex-col overflow-hidden">
      <SupportBanner />
      <div className="bridge min-h-0 flex-1">
        <Rail />
        <StatusStrip />
        <div className="bridge-main col-start-2 min-h-0 overflow-hidden">
          <Outlet />
        </div>
        <CommandPalette />
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Outlet });

function requireStaff(): void {
  if (useAdmin.getState().status === 'signed-out') throw redirect({ to: '/sign-in' });
}

const signInRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sign-in', component: SignInScreen });
const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'console',
  beforeLoad: requireStaff,
  component: ConsoleLayout,
});

const homeRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/', component: CommandCenterScreen });
const leadsRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/leads', component: LeadsScreen });
const leadDetailRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/leads/$leadId', component: LeadDetailScreen });
const MEMBER_LIFECYCLES = ['all', 'engaged', 'active', 'trial', 'frozen', 'grace', 'expired', 'former'] as const;
const MEMBER_RISKS = ['any', 'high', 'watch'] as const;
type MembersSearch = {
  offset?: number;
  q?: string;
  lifecycle?: (typeof MEMBER_LIFECYCLES)[number];
  risk?: (typeof MEMBER_RISKS)[number];
  joined?: 'this_month';
  expiring?: number;
};
const membersRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/members',
  component: MembersScreen,
  validateSearch: (search: Record<string, unknown>): MembersSearch => ({
    ...(Number.isSafeInteger(Number(search.offset)) && Number(search.offset) >= 0
      ? { offset: Number(search.offset) } : {}),
    ...(typeof search.q === 'string' && search.q.trim() ? { q: search.q } : {}),
    lifecycle: MEMBER_LIFECYCLES.includes(search.lifecycle as never)
      ? (search.lifecycle as MembersSearch['lifecycle'])
      : undefined,
    risk: MEMBER_RISKS.includes(search.risk as never) ? (search.risk as MembersSearch['risk']) : undefined,
    ...(search.joined === 'this_month' ? { joined: 'this_month' as const } : {}),
    ...(Number.isInteger(Number(search.expiring)) && Number(search.expiring) >= 1 && Number(search.expiring) <= 365
      ? { expiring: Number(search.expiring) }
      : {}),
  }),
});
const memberDetailRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/members/$memberId', component: MemberDetailScreen });
const plansRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/plans', component: PlansScreen });
const INVOICE_STATES = ['', 'outstanding', 'open', 'partially_paid', 'overdue', 'paid', 'void', 'partially_refunded', 'refunded'] as const;
type BillingSearch = { state?: (typeof INVOICE_STATES)[number] };
const billingRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/billing',
  component: BillingScreen,
  validateSearch: (search: Record<string, unknown>): BillingSearch => ({
    state: INVOICE_STATES.includes(search.state as never) ? (search.state as BillingSearch['state']) : undefined,
  }),
});
const floorRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/floor', component: FloorScreen });
/** The day grid and the recurrence rules behind it are two surfaces on one
 *  path, and which one is open belongs in the URL for the same reasons the
 *  store's do: a manager sends a colleague "the recurring classes screen". */
const SCHEDULE_TABS = ['day', 'series'] as const;
export interface ScheduleSearch {
  tab: (typeof SCHEDULE_TABS)[number];
}
const scheduleRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/schedule',
  component: ScheduleScreen,
  validateSearch: (search: Record<string, unknown>): ScheduleSearch => ({
    tab: SCHEDULE_TABS.includes(search.tab as never) ? (search.tab as ScheduleSearch['tab']) : 'day',
  }),
});
const trainingRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/training', component: TrainingScreen });
const trainingBuilderRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/training/$programId', component: TrainingBuilderScreen });
/** The directory and the commission ledger are two surfaces on one path. */
const STAFF_TABS = ['directory', 'commission'] as const;
export interface StaffSearch {
  tab: (typeof STAFF_TABS)[number];
}
const staffRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/staff',
  component: StaffScreen,
  validateSearch: (search: Record<string, unknown>): StaffSearch => ({
    tab: STAFF_TABS.includes(search.tab as never) ? (search.tab as StaffSearch['tab']) : 'directory',
  }),
});
const staffDetailRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/staff/$staffId', component: StaffDetailScreen });
/**
 * Store is the first module with several working surfaces behind one path, and
 * which surface is open is worth putting in the URL: a manager sends "the
 * transfers screen" to a colleague, a cashier reloads the till after a browser
 * update and expects to still be at the till, and back returns to where they
 * were rather than to the register. TanStack Router validates search on the
 * route, so an unknown or hand-edited value falls back rather than rendering
 * an empty pane.
 */
const STORE_TABS = ['register', 'inventory', 'orders', 'transfers', 'insights'] as const;
/** `7d` rather than `7`: the default serialiser JSON-quotes a string that
 *  parses as a number, and `?window=%2230%22` is not a URL anyone should be
 *  asked to read or paste. */
const STORE_WINDOWS = ['7d', '30d', '90d'] as const;

export interface StoreSearch {
  tab: (typeof STORE_TABS)[number];
  window: (typeof STORE_WINDOWS)[number];
}

const storeRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/store',
  component: StoreScreen,
  /*
   * Both keys always resolve to a valid value, and that is load-bearing rather
   * than tidy. Search params accumulate down the route tree: the pathless
   * `console` layout validates nothing, so whatever is in the URL reaches its
   * children, and a child validator that *omits* an unrecognised key leaves the
   * raw one standing underneath. `?tab=accounting` then reaches the screen as
   * `accounting`, matches no surface, and renders a blank pane. Returning a
   * concrete value overrides it, so the screen can never be handed a tab that
   * does not exist. The cost is two visible params on a bare `/admin/store`,
   * which is a fair price for a link that cannot land nowhere.
   */
  validateSearch: (search: Record<string, unknown>): StoreSearch => ({
    tab: STORE_TABS.includes(search.tab as never) ? (search.tab as StoreSearch['tab']) : 'register',
    window: STORE_WINDOWS.includes(search.window as never) ? (search.window as StoreSearch['window']) : '30d',
  }),
});
const equipmentRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/equipment', component: EquipmentScreen });
const AUTOMATIONS_TABS = ['rules', 'templates', 'runs'] as const;
type AutomationsSearch = { tab: (typeof AUTOMATIONS_TABS)[number] };

const automationsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/automations',
  component: AutomationsScreen,
  validateSearch: (search: Record<string, unknown>): AutomationsSearch => ({
    tab: AUTOMATIONS_TABS.includes(search.tab as never) ? (search.tab as AutomationsSearch['tab']) : 'rules',
  }),
});
const REPORT_TABS = ['revenue', 'membership', 'attendance', 'trainer', 'retention'] as const;

export interface ReportsSearch {
  tab: (typeof REPORT_TABS)[number];
  /** Local calendar dates in the reporting timezone. */
  from?: string;
  to?: string;
  branchId?: string;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* The report, the range and the branch all live in the URL.

   A report is something people send each other. "Revenue, Koramangala, last
   month" has to survive being pasted into a message, and a reload during a
   review must not silently drop back to the default range on a different
   report — which is the version of this that quietly makes two people discuss
   two different numbers. */
const reportsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/reports',
  component: ReportsScreen,
  validateSearch: (search: Record<string, unknown>): ReportsSearch => ({
    tab: REPORT_TABS.includes(search.tab as never) ? (search.tab as ReportsSearch['tab']) : 'revenue',
    ...(isDay(search.from) ? { from: search.from } : {}),
    ...(isDay(search.to) ? { to: search.to } : {}),
    ...(typeof search.branchId === 'string' && search.branchId.length > 0 ? { branchId: search.branchId } : {}),
  }),
});
/** Same reasoning as Store: which surface is open belongs in the URL, and the
 *  validator returns a concrete value so search accumulating down the pathless
 *  console layout cannot hand the screen a tab that does not exist. */
const SUPPORT_TABS = ['queue', 'feedback', 'retention'] as const;

export interface SupportSearch {
  tab: (typeof SUPPORT_TABS)[number];
  /** A ticket reference deep-link, so a breach alert can point straight at it. */
  ticket?: string;
}

const supportRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/support',
  component: SupportScreen,
  validateSearch: (search: Record<string, unknown>): SupportSearch => ({
    tab: SUPPORT_TABS.includes(search.tab as never) ? (search.tab as SupportSearch['tab']) : 'queue',
    ...(typeof search.ticket === 'string' && search.ticket.length > 0 ? { ticket: search.ticket } : {}),
  }),
});
const SETTINGS_TABS = ['business', 'branches', 'privacy', 'setup'] as const;
type SettingsSearch = { tab: (typeof SETTINGS_TABS)[number] };

const settingsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/settings',
  component: SettingsScreen,
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    tab: SETTINGS_TABS.includes(search.tab as never) ? (search.tab as SettingsSearch['tab']) : 'business',
  }),
});
const PLATFORM_TABS = ['tenants', 'health'] as const;
type PlatformSearch = { tab: (typeof PLATFORM_TABS)[number] };

const platformRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/platform',
  component: PlatformScreen,
  validateSearch: (search: Record<string, unknown>): PlatformSearch => ({
    tab: PLATFORM_TABS.includes(search.tab as never) ? (search.tab as PlatformSearch['tab']) : 'tenants',
  }),
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  consoleRoute.addChildren([
    homeRoute,
    leadsRoute,
    leadDetailRoute,
    membersRoute,
    memberDetailRoute,
    plansRoute,
    billingRoute,
    floorRoute,
    scheduleRoute,
    trainingRoute,
    trainingBuilderRoute,
    staffRoute,
    staffDetailRoute,
    storeRoute,
    equipmentRoute,
    automationsRoute,
    reportsRoute,
    supportRoute,
    settingsRoute,
    platformRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: RoutePending,
  basepath: '/admin',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
