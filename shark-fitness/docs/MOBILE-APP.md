# The member mobile app: install, push, Google Play and iOS

The member app is the PWA at `/app/`, distributed on Android as a Trusted Web
Activity (TWA) and installed on iPhone from Safari. Why, and when to revisit:
[ADR-002](ADR-002-member-mobile-app.md). This page is the operator's runbook.

Nothing here has been submitted to a store, and no APK has been built on the
development machine (it has no Android SDK). The GitHub workflow below is the
build path.

## 1. Before anything: the web app must be live

A TWA and a home-screen install are both windows onto the deployed site, so:

1. Deploy with HTTPS on the final host (`SITE_HOST`, e.g. `app.sharkfitness.in`).
2. Open `https://SITE_HOST/app/` on an Android phone in Chrome. Profile ›
   More › Install app should offer to install. Lighthouse's PWA checks are a
   good second opinion.
3. Optional but recommended: turn on push (section 4) first, so the Play build
   can delegate notifications from day one.

## 2. Build the Android package

GitHub › Actions › **android-twa** › Run workflow, with:

| Input | Value |
|---|---|
| `site_host` | the production host, no scheme (`app.sharkfitness.in`) |
| `package_id` | `in.sharkfitness.member` (placeholder; choose the final id once, it can never change on Play) |
| `version_name` / `version_code` | `1.0.0` / `1`; the code must go up with every upload |

The job installs Bubblewrap (pinned), rewrites
`apps/member-pwa/android/twa-manifest.json` for that host, generates a signing
keystore **inside the job**, and uploads `app-release-signed.apk`,
`app-release-bundle.aab` and the final `twa-manifest.json` as artifacts
(kept 14 days). The keystore is deleted before upload and never committed.

The log prints the SHA-256 fingerprint of that run's key. Use it only for
side-loading the APK on a test phone (section 3); Play uses its own key.

## 3. Digital Asset Links

Android only opens the TWA full screen (no browser bar) when the site vouches
for the app. The API serves `/.well-known/assetlinks.json` from two variables:

```bash
SHARK_ANDROID_PACKAGE=in.sharkfitness.member
SHARK_ANDROID_CERT_SHA256=AA:BB:…:99            # 32 colon-separated hex pairs; comma-separate several
```

Both or neither; a malformed fingerprint stops the server at boot. Unset, the
URL is a 404. Check it with
`curl https://SITE_HOST/.well-known/assetlinks.json` and Google's
[Statement List tester](https://developers.google.com/digital-asset-links/tools/generator).

Which fingerprints:

- **Play App Signing key** (Play Console › your app › Test and release › App
  integrity › App signing): what users install from Play is signed with this.
  Always include it.
- **Upload key**: the key the workflow generated for the AAB you uploaded.
  Include it while testing internal builds.
- A side-loaded test APK: that run's fingerprint from the workflow log.

## 4. Push notifications

Push is off until three variables are set (all or none):

```bash
pnpm -F @shark/api vapid:keys     # prints a fresh pair; keep the private key out of git
SHARK_VAPID_PUBLIC_KEY=…
SHARK_VAPID_PRIVATE_KEY=…
SHARK_VAPID_SUBJECT=mailto:ops@your-gym.example
```

With push off the app shows no notification settings at all. With it on,
members switch it on in Profile › Phone notifications, after a screen that says
what they will get. What is sent: class reminders (the *class tomorrow*
automation), class cancelled/changed, waitlist offers, messages from staff
(who wrote, never the text), payment due, payment received, and payment
outcomes from the payment provider (`notifyPaymentOutcome`). Every push
honours the member's `push_notifications` consent and the branch's quiet hours
(Settings › quietHoursFrom/To, branch timezone). Rotating the VAPID key pair
means every phone has to switch notifications on again.

In the TWA, `enableNotifications: true` delegates web notifications to the
Android app, so they appear under the app's own name and settings.

## 5. Google Play Console

1. Create the app (name *Shark Fitness*, default language English (India),
   app, free).
2. **Play App Signing**: accept it. Upload the AAB from section 2 to an
   *Internal testing* track; Play re-signs it with the app signing key.
3. Copy the app signing key's SHA-256 into `SHARK_ANDROID_CERT_SHA256`
   (section 3), redeploy, and install from the internal track. The app must
   open with no URL bar. A URL bar means asset links are not verified yet.
4. Store listing: short and full description, the 512 px icon
   (`apps/member-pwa/public/icons/icon-512.png`), a 1024×500 feature graphic
   (to be designed; not in the repo), phone screenshots (the manifest's
   `public/screenshots/*.jpg` are a start; Play wants at least two at 16:9 or
   9:16 within 320–3840 px).
5. App content: privacy policy URL (the website's privacy notice, draft until
   counsel review), ads: none, target audience 18+ (see the minors note below),
   content rating questionnaire, Data safety (section 6).
6. Promote internal → closed → production once the device checks in section 8
   pass.

For a long-lived release, replace the job-generated key with a permanent
*upload* key: create it once (`keytool -genkeypair …`), store it as a
GitHub encrypted secret, and change the workflow's keystore step to decode it.
Losing an upload key is recoverable through Play support; losing the
Play App Signing key is not possible because Google holds it.

## 6. Draft Data safety answers

Draft for the client and counsel to confirm; the TWA itself collects nothing
the website does not.

| Question | Draft answer |
|---|---|
| Does the app collect or share user data? | Collects; does not share with third parties for their own purposes |
| Encrypted in transit | Yes (HTTPS only) |
| Users can request deletion | Yes (Profile › Export and deletion; reviewed by the gym) |
| Personal info: name, email, phone | Collected, required, account management |
| Health and fitness: workouts, body measurements, habits | Collected, optional, app functionality |
| Financial info: purchase history (invoices) | Collected, required for members, app functionality; card data never touches our servers |
| Messages: in-app messages with staff | Collected, optional, app functionality |
| App activity: in-app actions, crash logs | Crash reports and diagnostics only, app functionality and analytics of failures |
| Device or other IDs | Push subscription endpoint, only if notifications are switched on |
| Location | Not collected |
| Photos | Not collected in this release (progress photos arrive with P05; update this form then) |

## 7. Permissions and their rationale

| Permission | When it is asked | What the member sees first |
|---|---|---|
| Notifications | Only after tapping *Turn on notifications* then *Allow notifications* in Profile | The list of what will be sent, that nothing comes in quiet hours, no marketing, and that lock screens show the title |
| Camera (P05, QR) | Not requested in this release | — |
| Location, contacts, microphone | Never | — |

Android 13+ shows the system notification prompt only from that tap. The
browser's own install prompt is always held back; the app never asks on a
first visit.

## 8. Checks to do on real devices

These cannot be done in CI (no device lab); record the results in the release
notes:

- Android, mid-range phone: install from Play internal track; cold start
  under 2.5 s (PRD 04 §11.1); no URL bar; a push notification opens the exact
  screen; airplane mode: Home, Train and Book still show the last data with the
  offline banner; a workout logged offline syncs after reconnecting.
- iPhone on iOS 16.4 or later: Safari › Share › Add to Home Screen; open from
  the home screen; turn on notifications in Profile (iOS shows the prompt only
  for home-screen apps); lock-screen notification opens the right screen.
- Tablet in both orientations: content column, two-column Book and Progress.
- Sign out on a shared phone: Profile › Sign out; the next person sees none of
  the previous member's data offline.

## 9. iOS: what installing from Safari means

- There is no App Store listing and no install button: the app shows the
  *Add to Home Screen* steps (Profile › More › Install app).
- Push works only once the app is on the home screen (iOS 16.4+), and only
  while the member keeps notifications allowed in iOS Settings.
- No vibration API: haptics do nothing on iPhone.
- iOS may clear a home-screen app's storage after weeks of non-use; offline
  data is a convenience, the server stays the record.
- Background sync is not available; queued workout sets send when the app is
  next opened online.

## 10. Minors

PRD 04 ENT-CHILD rules apply to the app exactly as to the website. Until the
client confirms the youngest member age, keep the Play target audience at 18+.

## Files

| What | Where |
|---|---|
| Web app manifest | `apps/member-pwa/manifest.config.ts` (built to `/app/manifest.webmanifest`) |
| Icons (one SVG source) | `apps/member-pwa/icons/source.svg` → `pnpm -F @shark/member-pwa icons` |
| Store screenshots | `pnpm -F @shark/e2e store-screenshots` (after `pnpm build`) |
| Service workers | `apps/member-pwa/src/sw/sw.ts` (`/app/`), `apps/admin-web/src/sw/sw.ts` (`/admin/`) |
| TWA definition | `apps/member-pwa/android/twa-manifest.json` |
| Build workflow | `.github/workflows/android-twa.yml` |
| Asset links | `apps/api/src/routes/asset-links.ts` |
| Push | `apps/api/src/services/push.ts`, `services/notifications.ts`, `routes/push-subscriptions.ts` |
