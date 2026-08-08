import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { CommandPalette, Rail, StatusStrip } from './ui/shell';
import { useAdmin } from './lib/store';

import SignInScreen from './screens/SignIn';
import CommandCenterScreen from './screens/CommandCenter';
import LeadsScreen from './screens/Leads';
import LeadDetailScreen from './screens/LeadDetail';
import MembersScreen from './screens/Members';
import MemberDetailScreen from './screens/MemberDetail';
import PlansScreen from './screens/Plans';
import BillingScreen from './screens/Billing';
import FloorScreen from './screens/Floor';
import ScheduleScreen from './screens/Schedule';
import TrainingScreen from './screens/Training';
import StaffScreen from './screens/Staff';
import StoreScreen from './screens/Store';
import EquipmentScreen from './screens/Equipment';
import AutomationsScreen from './screens/Automations';
import ReportsScreen from './screens/Reports';
import SupportScreen from './screens/Support';
import SettingsScreen from './screens/Settings';
import PlatformScreen from './screens/Platform';

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
const staffRoute = createRoute({ getParentRoute: () => consoleRoute, path: '/staff', component: StaffScreen });
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
    staffRoute,
    storeRoute,
    equipmentRoute,
    automationsRoute,
    reportsRoute,
    supportRoute,
    settingsRoute,
    platformRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', basepath: '/admin' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
