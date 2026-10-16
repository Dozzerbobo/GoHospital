# GoHospital Android APK — automatic build

An Android project (`android/`) and a GitHub Actions pipeline (`.github/workflows/android.yml`) build the signed APK in the cloud, host it on GitHub Releases, put it on your website at `/downloads/gohospital.apk`, and deploy everything to Cloudflare Pages.

## One-time setup (about 15 minutes)
1. Edit `wrangler.toml` and put your real D1 `database_id` in it.
2. Create a **private** repo on github.com (e.g. `gohospital`). Push this whole folder to it (branch `main`).
3. Cloudflare token: Cloudflare dashboard → My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers**, or a custom token with **Account → Cloudflare Pages → Edit**. Copy it. Also copy your **Account ID** (Workers & Pages page, right side).
4. GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
   - `CLOUDFLARE_API_TOKEN` = the token
   - `CLOUDFLARE_ACCOUNT_ID` = your account ID
5. GitHub repo → Actions → **Build Android APK + deploy to Cloudflare** → Run workflow.

## First run: save your signing key (important)
The first run creates your signing key. When it finishes, open the run and download the artifact **KEEP-SAFE-signing-key**. Then add three more secrets so every future build uses the same key (Android will refuse updates signed with a different key):
- `ANDROID_KEYSTORE_B64` = contents of `keystore.b64.txt`
- `ANDROID_KEYSTORE_PASSWORD` = the password in `passwords.txt`
- `ANDROID_KEY_ALIAS` = `gohospital`
Store the keystore file somewhere safe as well. Do this before running the workflow a second time.

## Result
- APK: `https://gohospital.online/downloads/gohospital.apk` (the /app page shows the Download button automatically) and under the repo's **Releases**.
- `/.well-known/assetlinks.json` is generated with your key's fingerprint, so the app opens full-screen without a browser bar.
- Always deploy through this pipeline (or keep the generated `assetlinks.json` and `downloads/gohospital.apk` in `public/`), otherwise a manual deploy removes them.

## Changing the app
Edit `android/app/src/main/AndroidManifest.xml` (URL, colors) or the icons in `android/app/src/main/res`. Pushing to `main` rebuilds.

## Notes
- The app is a Trusted Web Activity: it shows gohospital.online in full screen, so website updates reach users instantly with no new APK.
- This pipeline was written without being able to run an Android build in the authoring environment. If the Actions run fails, open the failed step and send me the error text.

## App experience (inside the APK / installed app)
When opened as the app, GoHospital shows a bottom tab bar (Home, Find, SOS, Saved, More), a splash screen, no website footer, and a Save (heart) button on every hospital. Saved hospitals are kept on the phone at /saved and flag when a saved hospital's emergency status changes. In a normal browser the site looks as before.
