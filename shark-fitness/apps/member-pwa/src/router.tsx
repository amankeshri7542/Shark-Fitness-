import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { AppHeader, BottomNav } from './ui/shell';
import { useActiveBranch, useSession } from './lib/store';

// Sign-in stays in the entry chunk. It is the first screen an unauthenticated
// visitor sees, so making them wait on a second request to render it would
// trade a smaller bundle for a slower first paint on the one path everybody
// hits. Every screen behind the session gate is fetched on demand instead,
// and `defaultPreload: 'intent'` warms the chunk as soon as a tab is hovered
// or touched, so navigation still feels immediate.
import SignInScreen from './screens/SignIn';

const HomeScreen = lazyRouteComponent(() => import('./screens/Home'));
const PassScreen = lazyRouteComponent(() => import('./screens/Pass'));
const TrainScreen = lazyRouteComponent(() => import('./screens/Train'));
const WorkoutScreen = lazyRouteComponent(() => import('./screens/Workout'));
const SummaryScreen = lazyRouteComponent(() => import('./screens/Summary'));
const ExerciseScreen = lazyRouteComponent(() => import('./screens/Exercise'));
const BookScreen = lazyRouteComponent(() => import('./screens/Book'));
const ProgressScreen = lazyRouteComponent(() => import('./screens/Progress'));
const HabitsScreen = lazyRouteComponent(() => import('./screens/Habits'));
const PackScreen = lazyRouteComponent(() => import('./screens/Pack'));
const ChallengeScreen = lazyRouteComponent(() => import('./screens/Challenge'));
const MessagesScreen = lazyRouteComponent(() => import('./screens/Messages'));
const ConversationScreen = lazyRouteComponent(() => import('./screens/Conversation'));
const BillingScreen = lazyRouteComponent(() => import('./screens/Billing'));
const LibraryScreen = lazyRouteComponent(() => import('./screens/Library'));
const ProfileScreen = lazyRouteComponent(() => import('./screens/Profile'));
const NotificationsScreen = lazyRouteComponent(() => import('./screens/Notifications'));

/** Shown while a route chunk is in flight. Mirrors the boot splash so a slow
 *  network looks like the app loading, not the app breaking. */
function RoutePending() {
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <span
        aria-hidden="true"
        className="h-1.5 w-16"
        style={{ background: 'repeating-linear-gradient(90deg, var(--sf-sonar) 0 2px, transparent 2px 6px)' }}
      />
      <span className="sr-only">Loading</span>
    </div>
  );
}

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
  defaultPendingComponent: RoutePending,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
