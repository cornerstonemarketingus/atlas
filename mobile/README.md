# Atlas mobile shell

A thin Capacitor shell around the responsive Atlas web app. It exists for the
four things a bookmark cannot do:

- **Background push** for pending approvals, so a decision reaches the operator
  when the app is closed.
- **Biometric re-authentication** at the moment of a high-risk approval. Session
  authentication proves the device was enrolled; it does not prove the person
  holding an unlocked phone is the operator.
- **Credentials in the Keychain or Android Keystore**, never in web storage.
- **Deep links** that open the exact pending approval, verified before anything
  is navigated to.

Do not submit a plain WebView. Apple and Google both reject wrapped websites,
and more to the point a wrapper would deliver none of the above.

## What lives where

| Concern | Where |
| --- | --- |
| Signed deep links, push payloads, biometric policy, session states, crash redaction | `apps/local-control/src/mobile/` — shared with the daemon, which issues the links |
| Keychain/Keystore access, plugin wiring, deep-link handling | `mobile/src/` |
| Native projects | `mobile/ios/`, `mobile/android/` — generated, not checked in yet |

## Building

The native projects are generated rather than committed, so the platform
tooling owns them:

```
cd mobile
npm install
npx cap add ios
npx cap add android
npm run sync
npm run open:ios      # or open:android
```

`www/` must contain a build of the responsive web app before `cap sync`.

## Universal and app links

Serve the association files from the Atlas web host. Generate them rather than
writing them by hand — a typo in either silently downgrades every link to
opening a web page instead of the app:

```js
import { appleAppSiteAssociation, androidAssetLinks } from "../apps/local-control/src/mobile/deep-links.mjs";
```

- iOS: `/.well-known/apple-app-site-association`, served as `application/json`
  with no redirect.
- Android: `/.well-known/assetlinks.json`, with the release signing
  certificate's SHA-256 fingerprint.

## What is not done

The native projects have never been generated, built, or submitted from this
repository. Everything in `mobile/src/` and `apps/local-control/src/mobile/` is
covered by tests; none of it has run on a physical device. See
[`../MOBILE-RELEASE.md`](../MOBILE-RELEASE.md) for the remaining store gates,
including Sign in with Apple, which is still open.
