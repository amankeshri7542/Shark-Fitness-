/**
 * Every route of the three apps, as the audit walks them.
 *
 * Console tabs whose state lives in the URL (`?tab=`) are separate entries:
 * each is a different screen to a user and gets its own screenshot set. Paths
 * with an id (`:lead`, `:member` …) are filled in at run time from the seeded
 * demo data (lib/ids.ts), so the audit always looks at real records.
 *
 * `screen` is the PRD 03 screen contract the route answers to; routes the PRD
 * never drew carry the PRD 01 module they implement instead.
 */

export type App = 'website' | 'member' | 'admin';

export interface AuditRoute {
  app: App;
  /** Stable slug, used for file names and the coverage table. */
  slug: string;
  /** Path under the origin; `:name` placeholders resolve from lib/ids.ts. */
  path: string;
  title: string;
  /** PRD 03 screen id (UX-A01 …, UX-M01 …, WEB) or PRD 01 module reference. */
  screen: string;
  /** Signed-out routes (sign-in screens, the website). */
  public?: boolean;
  /** Key screens: accessibility-tree snapshot, Lighthouse, keyboard focus order. */
  key?: boolean;
}

const web = (slug: string, path: string, title: string, key = false): AuditRoute => ({
  app: 'website',
  slug,
  path,
  title,
  screen: 'WEB',
  public: true,
  key,
});

export const WEBSITE_ROUTES: AuditRoute[] = [
  web('home', '/', 'Home', true),
  web('plans', '/plans/', 'Plans', true),
  web('classes', '/classes/', 'Classes'),
  web('coaches', '/coaches/', 'Coaches'),
  web('locations', '/locations/', 'Locations'),
  web('location-koramangala', '/locations/koramangala/', 'Location: Koramangala'),
  web('location-indiranagar', '/locations/indiranagar/', 'Location: Indiranagar'),
  web('location-hsr', '/locations/hsr/', 'Location: HSR Layout'),
  web('free-trial', '/free-trial/', 'Free trial', true),
  web('about', '/about/', 'About'),
  web('faq', '/faq/', 'FAQ'),
  web('contact', '/contact/', 'Contact'),
  web('privacy', '/privacy/', 'Privacy notice'),
  web('terms', '/terms/', 'Terms'),
  web('not-found', '/no-such-page/', 'Not found (404)'),
];

const mem = (slug: string, path: string, title: string, screen: string, extra: Partial<AuditRoute> = {}): AuditRoute => ({
  app: 'member',
  slug,
  path: `/app${path}`,
  title,
  screen,
  ...extra,
});

export const MEMBER_ROUTES: AuditRoute[] = [
  mem('sign-in', '/sign-in', 'Sign in', 'UX-M01', { public: true, key: true }),
  mem('home', '/', 'Home', 'UX-M02', { key: true }),
  mem('pass', '/pass', 'Gym pass', 'UX-M03', { key: true }),
  mem('book', '/book', 'Book', 'UX-M04', { key: true }),
  mem('workout', '/workout', 'Active workout', 'UX-M05', { key: true }),
  mem('workout-freestyle', '/workout?mode=freestyle', 'Freestyle workout', 'UX-M05'),
  mem('summary', '/workout/summary/:workout', 'Workout summary', 'UX-M06'),
  mem('train', '/train', 'Train (plan)', 'UX-M07'),
  mem('exercise', '/train/exercise/:exercise', 'Exercise detail', 'UX-M07'),
  mem('progress', '/progress', 'Progress', 'UX-M08', { key: true }),
  mem('habits', '/habits', 'Habits', 'UX-M09'),
  mem('challenge', '/pack/challenge/:challenge', 'Challenge', 'UX-M10'),
  mem('pack', '/pack', 'Community (Pack)', 'UX-M11'),
  mem('messages', '/messages', 'Messages', 'UX-M12'),
  mem('message-new', '/messages/new', 'New message', 'UX-M12'),
  mem('conversation', '/messages/:conversation', 'Conversation', 'UX-M12'),
  mem('help', '/help', 'Help and support', 'UX-M12'),
  mem('library', '/library', 'Library', 'UX-M13'),
  mem('profile', '/profile', 'Profile and settings', 'UX-M14', { key: true }),
  mem('notifications', '/notifications', 'Notifications', 'UX-M14'),
  mem('billing', '/billing', 'Billing', 'UX-M14 / PF-BILL'),
];

const adm = (slug: string, path: string, title: string, screen: string, extra: Partial<AuditRoute> = {}): AuditRoute => ({
  app: 'admin',
  slug,
  path: `/admin${path}`,
  title,
  screen,
  ...extra,
});

export const ADMIN_ROUTES: AuditRoute[] = [
  adm('sign-in', '/sign-in', 'Sign in', 'Console auth', { public: true, key: true }),
  adm('command-center', '/', 'Command Center', 'UX-A01', { key: true }),
  adm('leads', '/leads', 'Leads', 'UX-A02', { key: true }),
  adm('lead-detail', '/leads/:lead', 'Lead detail', 'UX-A03'),
  adm('members', '/members', 'Members', 'UX-A04', { key: true }),
  adm('member-detail', '/members/:member', 'Member 360', 'UX-A05', { key: true }),
  adm('plans', '/plans', 'Plans', 'UX-A06'),
  adm('billing', '/billing', 'Billing', 'UX-A07', { key: true }),
  adm('floor', '/floor', 'Floor', 'UX-A08', { key: true }),
  adm('schedule', '/schedule?tab=day', 'Schedule: day', 'UX-A09', { key: true }),
  adm('schedule-series', '/schedule?tab=series', 'Schedule: series', 'UX-A09'),
  adm('staff', '/staff?tab=directory', 'Staff: directory', 'UX-A10'),
  adm('staff-commission', '/staff?tab=commission', 'Staff: commission', 'UX-A10'),
  adm('staff-detail', '/staff/:staff', 'Staff detail', 'UX-A10'),
  adm('training', '/training', 'Training: programs', 'UX-A11'),
  adm('training-builder', '/training/:program', 'Program builder', 'UX-A11'),
  adm('automations', '/automations?tab=rules', 'Automations: rules', 'UX-A12'),
  adm('automations-templates', '/automations?tab=templates', 'Automations: templates', 'UX-A12'),
  adm('automations-runs', '/automations?tab=runs', 'Automations: runs', 'UX-A12'),
  adm('reports-revenue', '/reports?tab=revenue', 'Reports: revenue', 'UX-A13', { key: true }),
  adm('reports-membership', '/reports?tab=membership', 'Reports: membership', 'UX-A13'),
  adm('reports-attendance', '/reports?tab=attendance', 'Reports: attendance', 'UX-A13'),
  adm('reports-trainer', '/reports?tab=trainer', 'Reports: trainer', 'UX-A13'),
  adm('reports-retention', '/reports?tab=retention', 'Reports: retention', 'UX-A13'),
  adm('store-register', '/store?tab=register&window=30d', 'Store: register', 'UX-A14'),
  adm('store-inventory', '/store?tab=inventory&window=30d', 'Store: inventory', 'UX-A14'),
  adm('store-orders', '/store?tab=orders&window=30d', 'Store: orders', 'UX-A14'),
  adm('store-transfers', '/store?tab=transfers&window=30d', 'Store: transfers', 'UX-A14'),
  adm('store-insights', '/store?tab=insights&window=30d', 'Store: insights', 'UX-A14'),
  adm('equipment', '/equipment', 'Equipment', 'UX-A14'),
  adm('settings-business', '/settings?tab=business', 'Settings: business', 'UX-A15'),
  adm('settings-branches', '/settings?tab=branches', 'Settings: branches', 'UX-A15'),
  adm('settings-privacy', '/settings?tab=privacy', 'Settings: privacy', 'UX-A15'),
  adm('settings-security', '/settings?tab=security', 'Settings: security', 'UX-A15'),
  adm('settings-integrations', '/settings?tab=integrations', 'Settings: integrations', 'UX-A15'),
  adm('settings-setup', '/settings?tab=setup', 'Settings: setup', 'UX-A15'),
  adm('platform-tenants', '/platform?tab=tenants', 'Platform: tenants', 'UX-A15'),
  adm('platform-health', '/platform?tab=health', 'Platform: health', 'UX-A15'),
  adm('support-queue', '/support?tab=queue', 'Support: queue', 'PRD 01 §4.20 Support'),
  adm('support-feedback', '/support?tab=feedback', 'Support: feedback', 'PRD 01 §4.20 Support'),
  adm('support-retention', '/support?tab=retention', 'Support: retention', 'PRD 01 §4.20 Support'),
  adm('inbox', '/inbox', 'Inbox', 'PRD 01 §4.15 Communication'),
  adm('tasks', '/tasks?view=mine', 'Tasks: mine', 'PRD 01 §3.1 Tasks'),
  adm('tasks-open', '/tasks?view=open', 'Tasks: open', 'PRD 01 §3.1 Tasks'),
  adm('tasks-done', '/tasks?view=done', 'Tasks: done', 'PRD 01 §3.1 Tasks'),
  adm('coaching', '/coaching', 'Coaching (nutrition and habits)', 'PRD 01 §3.1 Nutrition & Habits'),
  adm('marketing', '/marketing', 'Marketing', 'PRD 01 §3.1 Marketing'),
  adm('community', '/community', 'Community moderation', 'PRD 01 §3.1 Community'),
  adm('account', '/account', 'Your account', 'UX-A15 (own security)'),
];

export const ALL_ROUTES: AuditRoute[] = [...WEBSITE_ROUTES, ...MEMBER_ROUTES, ...ADMIN_ROUTES];

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

/** PRD 03 "Admin web breakpoints" and "Mobile test matrix". */
export const VIEWPORTS: Viewport[] = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
  { name: '360x800', width: 360, height: 800 },
];

export type Theme = 'dark' | 'light';
export const THEMES: Theme[] = ['dark', 'light'];

/** Where each app is primarily used: the viewport its per-route checks run at. */
export const PRIMARY_VIEWPORT: Record<App, Viewport> = {
  website: VIEWPORTS[3]!,
  member: VIEWPORTS[3]!,
  admin: VIEWPORTS[0]!,
};
