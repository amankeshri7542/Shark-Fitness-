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
const storeRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/store', component: StoreScreen });
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
