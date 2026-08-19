import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { CommandPalette, Rail, StatusStrip } from './ui/shell';
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
    <div className="bridge">
      <Rail />
      <StatusStrip />
      <div className="col-start-2 min-h-0 overflow-hidden">
        <Outlet />
      </div>
      <CommandPalette />
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
const membersRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/members', component: MembersScreen });
const memberDetailRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/members/$memberId', component: MemberDetailScreen });
const plansRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/plans', component: PlansScreen });
const billingRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/billing', component: BillingScreen });
const floorRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/floor', component: FloorScreen });
const scheduleRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/schedule', component: ScheduleScreen });
const trainingRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/training', component: TrainingScreen });
const trainingBuilderRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/training/$programId', component: TrainingBuilderScreen });
const staffRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/staff', component: StaffScreen });
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
const automationsRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/automations', component: AutomationsScreen });
const reportsRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/reports', component: ReportsScreen });
const supportRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/support', component: SupportScreen });
const settingsRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/settings', component: SettingsScreen });
const platformRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/platform', component: PlatformScreen });

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
