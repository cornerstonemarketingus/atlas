# Atlas mobile shell

A Capacitor app that pairs a phone with an Atlas daemon (`apps/local-control`)
and shows what is waiting there. It is early. This page separates what the
shipped web assets do today from what is planned.

## What works today

The app loads `www/index.html`, which runs `www/launch.mjs` and
`www/device-client.mjs`. That is the whole runtime.

- **Pairing.** You enter the Atlas server's HTTPS origin and a six-digit
  pairing code. An owner session creates the code with `POST /v1/pair` on the
  daemon, and it expires after five minutes. The app claims it with
  `POST /v1/pair/claim`. It only accepts an `https:` origin with no path,
  credentials, query or fragment, and it refuses redirects.
- **Device credential storage.** The device token returned by the claim is
  saved through `capacitor-secure-storage-plugin` (`SecureStoragePlugin`), not
  in web storage. Disconnecting removes it. Revoking the device in Atlas device
  settings ends its access on the server.
- **Counts.** After pairing, the app calls `GET /v1/tasks` and
  `GET /v1/approvals` and shows two numbers: the number of tasks and the number
  of pending approvals. Task contents and approval details are not shown.
- **No decisions.** The screen states it directly: "Mobile decisions are not
  yet available." Approvals are still made on the owner device.
- Opened outside the native app (for example in a desktop browser), the page
  refuses to pair.

`tests/daemon-contract.test.mjs` runs the device client against a real
`createLocalControlServer` instance. It covers code consumption, restoring a
session and rejecting a revoked device.

## Built but not loaded

These modules have tests, but nothing in `www/` imports them, so the app does
not use them:

| Module | Intended job |
| --- | --- |
| `mobile/src/bridge.mjs` (`startShell`) | Wire push registration, deep links and secure storage into the shell |
| `mobile/src/secure-storage.mjs` | Keychain/Keystore wrapper that refuses credentials in web storage |
| `mobile/src/deep-link-handler.mjs` | Verify a signed deep link before navigating to an approval |
| `apps/local-control/src/mobile/{push,biometric-policy,deep-links,session-state,crash-reporting}.mjs` | Daemon-side push payloads, biometric policy for high-risk approvals, signed links and association files, session states, crash-report redaction. No daemon code imports them either. |

The native projects include the push-notification and biometric plugins
(`ios/App/Podfile`, `android/capacitor.settings.gradle`), but no code calls
them. The Atlas web host does not serve `/.well-known/apple-app-site-association`
or `/.well-known/assetlinks.json`, so universal links and app links do not open
the app.

## Planned

- Background push for pending approvals.
- Biometric re-authentication before a high-risk approval.
- Signed deep links that open the exact pending approval.
- Approving or rejecting from the phone.

Native work in progress:

- [#320](https://github.com/cornerstonemarketingus/atlas/pull/320): compiles
  the Android debug and iOS simulator apps in CI.
- [#329](https://github.com/cornerstonemarketingus/atlas/pull/329): checks
  that native secure storage works before a pairing code is used up.

Neither PR has merged as of 2026-10-20. Neither app has run on a physical
device or been submitted to a store. See
[`../MOBILE-RELEASE.md`](../MOBILE-RELEASE.md) for the store gates, including
Sign in with Apple.

## Building

The native projects in `ios/` and `android/` are generated and checked in. The
iOS project needs macOS, Xcode and CocoaPods.

```
cd mobile
npm install
npm run sync          # cap sync: copies www/ into the native projects
npm run open:ios      # or open:android
```

Checks, as CI runs them: `npm run check && npm test`.

## Native icon artwork

Native icons are rendered from `apps/web/public/favicon.svg`, keeping its paths
and colors. Run `npm run icons:render` from `mobile` after installing the
browser-worker dependencies and Chromium. Alternatively, set
`ATLAS_TEST_PLAYWRIGHT` and `ATLAS_TEST_BROWSER` to use a browser you already
have installed. The app gets no runtime browser dependency.

The generator writes the opaque 1024px iOS catalog icon and five Android
densities for legacy, round and transparent adaptive foreground icons.
`icon-manifest.json` records the canonical SVG digest, the renderer version and
the artifact hashes. The mobile tests check dimensions, Apple opacity, adaptive
transparency, source freshness and real RGB pixels in the negative space.
Regenerate the icons after changing the source vector. App Store screenshots,
final launch screens and the physical-device masking review are still release
work.
