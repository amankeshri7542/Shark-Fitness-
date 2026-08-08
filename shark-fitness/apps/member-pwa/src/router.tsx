import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { AppHeader, BottomNav } from './ui/shell';
import { useActiveBranch, useSession } from './lib/store';

import SignInScreen from './screens/SignIn';
import HomeScreen from './screens/Home';
import PassScreen from './screens/Pass';
import TrainScreen from './screens/Train';
import WorkoutScreen from './screens/Workout';
import SummaryScreen from './screens/Summary';
import ExerciseScreen from './screens/Exercise';
import BookScreen from './screens/Book';
import ProgressScreen from './screens/Progress';
import HabitsScreen from './screens/Habits';
import PackScreen from './screens/Pack';
import ChallengeScreen from './screens/Challenge';
import MessagesScreen from './screens/Messages';
import ConversationScreen from './screens/Conversation';
import BillingScreen from './screens/Billing';
import LibraryScreen from './screens/Library';
import ProfileScreen from './screens/Profile';
import NotificationsScreen from './screens/Notifications';

/* The chrome the tabbed screens share. Full-screen surfaces — the workout
   logger, the entry pass — deliberately sit outside it so nothing competes
   with logging a set or getting through a door. */
function TabLayout() {
  const branch = useActiveBranch();
  return (
    <>
      <AppHeader branchName={branch?.name ?? 'Shark Fitness'} />
      <Outlet />
      <BottomNav />
    </>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <div className="sf-device">
      <Outlet />
    </div>
  ),
});

/** Everything below this gate needs a session. */
function requireSession(): void {
  if (useSession.getState().status === 'signed-out') {
    throw redirect({ to: '/sign-in' });
  }
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  component: SignInScreen,
});

const tabsRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'tabs',
  beforeLoad: requireSession,
  component: TabLayout,
});

const bareRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'bare',
  beforeLoad: requireSession,
  component: Outlet,
});

const homeRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/', component: HomeScreen });
const trainRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/train', component: TrainScreen });
const exerciseRoute = createRoute({
  getParentRoute: () => tabsRoute,
  path: '/train/exercise/$exerciseId',
  component: ExerciseScreen,
});
const progressRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/progress', component: ProgressScreen });
const packRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/pack', component: PackScreen });
const challengeRoute = createRoute({
  getParentRoute: () => tabsRoute,
  path: '/pack/challenge/$challengeId',
  component: ChallengeScreen,
});
const bookRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/book', component: BookScreen });
const habitsRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/habits', component: HabitsScreen });
const messagesRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/messages', component: MessagesScreen });
const conversationRoute = createRoute({
  getParentRoute: () => tabsRoute,
  path: '/messages/$conversationId',
  component: ConversationScreen,
});
const billingRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/billing', component: BillingScreen });
const libraryRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/library', component: LibraryScreen });
const profileRoute = createRoute({ getParentRoute: () => tabsRoute, path: '/profile', component: ProfileScreen });
const notificationsRoute = createRoute({
  getParentRoute: () => tabsRoute,
  path: '/notifications',
  component: NotificationsScreen,
});

const passRoute = createRoute({ getParentRoute: () => bareRoute, path: '/pass', component: PassScreen });
const workoutRoute = createRoute({ getParentRoute: () => bareRoute, path: '/workout', component: WorkoutScreen });
const summaryRoute = createRoute({
  getParentRoute: () => bareRoute,
  path: '/workout/summary/$workoutId',
  component: SummaryScreen,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  tabsRoute.addChildren([
    homeRoute,
    trainRoute,
    exerciseRoute,
    progressRoute,
    packRoute,
    challengeRoute,
    bookRoute,
    habitsRoute,
    messagesRoute,
    conversationRoute,
    billingRoute,
    libraryRoute,
    profileRoute,
    notificationsRoute,
  ]),
  bareRoute.addChildren([passRoute, workoutRoute, summaryRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
