# Android Trusted Web Activity

`twa-manifest.json` is the Bubblewrap project definition for the Play Store
build of the member app. The host `app.sharkfitness.example` is a placeholder:
the `android-twa` GitHub workflow replaces it with the `site_host` you give it
(the production `SITE_HOST`) before building. Nothing else here is generated
or committed: the Android project, the keystore and the APK/AAB exist only
inside the workflow run.

See `shark-fitness/docs/MOBILE-APP.md` for the Play Console steps.
