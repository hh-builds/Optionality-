# Optionality — native app (Capacitor)

Wraps the existing Financial Optionality web app as installable **iOS** and **Android**
apps, reusing the same codebase. The web app in `../src` / `../index.html` stays the
source of truth; this folder just packages a self-contained, offline copy of it.

## What's already done (in the repo)
- `www/` — a **self-contained, offline, CDN-free** build of the app:
  - `index.html` (the app shell, with the CDN `<script>`s swapped for local files
    and the in-browser Babel removed),
  - `app.js` (the UI **precompiled** from JSX to plain JS — no runtime Babel),
  - `vendor/` (React, ReactDOM, PropTypes, Recharts UMD builds served locally).
  Verified to render fully offline (all charts included) with zero network.
- `capacitor.config.json` — appId `uk.futurefunded.app`, appName **Optionality**,
  `webDir: www`. Change `appId` to whatever bundle ID you'll register with Apple/Google.
- `resources/icon.png` — 1024×1024 app icon (brand blue, rising line, green node).
- `build-www.mjs` — regenerates `www/index.html` + `www/app.js` from `../index.html`.

## Prerequisites (on YOUR machine — can't be done in the cloud)
- **Node 18+** and npm.
- **iOS:** macOS + **Xcode** (from the App Store) + **CocoaPods** (`sudo gem install cocoapods`),
  and a (free or paid) **Apple Developer** account. A paid account ($99/yr) is required to ship
  to the App Store; a free one is enough to run on your own device.
- **Android:** **Android Studio** (bundles the SDK + JDK). A **Google Play Developer** account
  ($25 one-off) is required to publish.

## One-time setup
```bash
cd mobile-app
npm install                 # installs Capacitor CLI + native platform packages
npx cap add ios             # macOS only — creates ios/ (runs pod install)
npx cap add android         # creates android/
npm run icons               # generates all icon/splash sizes from resources/icon.png
npx cap sync                # copies www/ into the native projects
```

## Run / build
```bash
npx cap open ios            # opens Xcode → pick your Team under Signing → Run (device/simulator)
npx cap open android        # opens Android Studio → Run, or Build > Generate Signed Bundle/APK
```
- **iOS App Store:** in Xcode, Product > Archive → Distribute App.
- **Google Play:** in Android Studio, Build > Generate Signed App Bundle (`.aab`) → upload in Play Console.

## Updating the app after web changes
The native app ships a *snapshot* of the web build. To push changes:
```bash
# from the repo root, after editing src/ and running ./build.sh:
cd mobile-app
npm run build:www           # rebuild www/index.html + www/app.js from ../index.html
npx cap sync                # copy into ios/ + android/
```
then re-run / re-archive in Xcode / Android Studio and submit the new version.

## Notes
- **Offline by design:** no CDN at runtime; everything is bundled. Good for app-store review
  (no remote code execution) and for users with no signal.
- **Updating vendored libraries:** the files in `www/vendor/` are copied from npm
  (`react`, `react-dom`, `prop-types`, `recharts` UMD builds). To refresh, install those
  packages and copy the UMD files over, then `npm run build:www`.
- **appId / signing:** `uk.futurefunded.app` is a placeholder — set it to your registered
  bundle ID before your first store submission (changing it later means a new app listing).
- **Live web updates (optional, later):** Capacitor supports over-the-air web-asset updates
  (e.g. `@capacitor/live-updates`) or pointing `server.url` at the GitHub Pages site, so you
  could push UI changes without a full store resubmission. Not enabled here.
