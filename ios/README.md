# BioPicker for iOS

A native WKWebView shell around the BioPicker web app. All work (AI, TTS, rendering) still happens on a BioPicker server; the app just loads it.

## Server
The server listens on 127.0.0.1 by default, so a phone can't reach it. To serve your LAN:

    HOST=0.0.0.0 APP_PASSCODE=<pick one> npm start

The app defaults to `https://biopicker.eperflabs.com` (108.93.174.9). If it can't connect it shows an address field; you can also **shake the phone** at any time to change the server. Any http/https URL works (LAN IP, Tailscale, a hosted domain).

## Build & install (no Xcode GUI needed)
The output must live outside ~/Documents: iCloud/Finder extended attributes there break codesign.

    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
    xcodebuild -project ios/BioPicker.xcodeproj -scheme BioPicker -configuration Debug \
      -destination 'generic/platform=iOS' -allowProvisioningUpdates \
      -derivedDataPath ~/Library/Developer/Xcode/DerivedData/BioPicker-ios build
    xcrun devicectl list devices
    xcrun devicectl device install app --device <id> \
      ~/Library/Developer/Xcode/DerivedData/BioPicker-ios/Build/Products/Debug-iphoneos/BioPicker.app

Signing is automatic with team XKQ3C2A6A9 (bundle id com.eperf.biopicker). Development builds expire with the provisioning profile (Feb 2027); rebuild and reinstall to renew.

## What the app adds over a web page
- **Photos with their dates and places:** the native picker reads each photo's date and location (from the file, or from the Photos library when the file lacks it), converts HEIC to JPEG, and uploads with the signed-in session.
- **"Your film is ready" notifications:** permission is asked the first time you render; the server sends the push when the render finishes (needs `APNS_*` on the server, see ../DEPLOY.md). Tapping it opens that biopic's Render step.
- **Save films to Photos** (or share them) from the MP4 download buttons.
- **Share sheet** for Word, backup .zip and captions.
- Terms, Privacy and public films open in an in-app browser.
- Native alert/confirm/prompt, pull-to-refresh, back/forward swipe, inline video, audio with the silent switch on. Web Inspector enabled: Safari ▸ Develop ▸ iPhone.

## How the page and the app talk
The page calls `window.webkit.messageHandlers.bpNative.postMessage({type})` (`pickPhotos`, `signedIn`, `wantNotifications`, and for purchases `products`, `buy`, `finish`, `restore`) and the app calls back into `window.bpNative` (`toast`, `registerDevice`, `applePurchase`). The app adds `BioPickerApp/1.2` to its user agent so the server can tell it from Safari. In a normal browser the handler doesn't exist and the page falls back to web behaviour, so the same server code serves both. Messages are only accepted from the configured server.

## Push notifications and signing
Push needs an explicit App ID with the Push Notifications capability, so the wildcard profile is no longer enough. With Xcode signed in (Settings ▸ Accounts) as an Admin of team XKQ3C2A6A9, `-allowProvisioningUpdates` registers it automatically.

## In-App Purchase (paid plans)
Paid plans are auto-renewable subscriptions bought with StoreKit 2 (`NativeBridge.swift`). The page asks the app for App Store prices, the app runs the purchase with an `appAccountToken` that ties it to the BioPicker account, and the server checks Apple's signature before changing the plan. A transaction is finished only after the server has recorded it; renewals, refunds and Ask to Buy approvals arrive through `Transaction.updates` and App Store Server Notifications. **Restore purchases** is in the Plans dialog (Apple requires it).

Set up once in App Store Connect (Account Holder or Admin):
1. Agreements, Tax, and Banking: accept the **Paid Apps** agreement and add bank and tax details. Nothing can be sold until this is active.
2. Your app → Monetization → Subscriptions: create a subscription group (e.g. "BioPicker plans") and one auto-renewable subscription per paid plan, product id e.g. `com.eperf.biopicker.plus`, duration 1 month, price, display name and description, and a review screenshot of the Plans dialog.
3. Copy each product id into the plan on the admin panel's Plans & paywall page.
4. App Information → App Store Server Notifications: the address shown on Plans & paywall, **Version 2**, for Production and Sandbox.
5. Users and Access → Sandbox → add a sandbox tester to try purchases on a device (Settings → App Store → Sandbox Account).
6. Submit the subscriptions **with** a new app version: the first In-App Purchases of an app must be reviewed together with a build. Add a note for the reviewer with a demo account.

The app's privacy label (App Privacy) also needs updating for purchases, coarse location (from IP) and device data; see ../public/privacy.html.
