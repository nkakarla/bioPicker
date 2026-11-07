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
- Authenticator setup opens the iPhone Passwords app (otpauth links); Terms, Privacy and public films open in an in-app browser.
- Native alert/confirm/prompt, pull-to-refresh, back/forward swipe, inline video, audio with the silent switch on. Web Inspector enabled: Safari ▸ Develop ▸ iPhone.

## How the page and the app talk
The page calls `window.webkit.messageHandlers.bpNative.postMessage({type})` (`pickPhotos`, `signedIn`, `wantNotifications`) and the app calls back into `window.bpNative` (`toast`, `registerDevice`). In a normal browser the handler doesn't exist and the page falls back to web behaviour, so the same server code serves both. Messages are only accepted from the configured server.

## Push notifications and signing
Push needs an explicit App ID with the Push Notifications capability, so the wildcard profile is no longer enough. With Xcode signed in (Settings ▸ Accounts) as an Admin of team XKQ3C2A6A9, `-allowProvisioningUpdates` registers it automatically.
