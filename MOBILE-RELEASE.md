# Atlas mobile release readiness

Updated 2026-09-15. This is the release gate for Apple App Store and Google
Play distribution. The web app remains the product core; a native shell should
be introduced only when it adds mobile value beyond a wrapped website.

## Ready now

- Responsive authenticated web control plane and phone-width setup center.
- Installable web-app manifest and standalone display metadata.
- Public privacy policy and terms pages.
- An authenticated, in-app account-deletion request path.
- Hosted-browser access is plan-gated; Windows companion is the default.
- System, light, and dark appearance controls are available in the authenticated shell and persist without storing credentials.
- The production bundle identifier is `com.cornerstonemarketingus.atlas`; cleartext and mixed-content traffic are disabled in both native shells.

## P0 — required before store submission

- [ ] Add Sign in with Apple on iOS, or obtain a documented review exception.
      GitHub is currently the only customer login and is a third-party login.
- [x] Build a deletion processor and operator audit view. The current page
      starts a request but does not yet erase or anonymize records.
- [x] Add a public web deletion-request URL that works for users who no longer
      have the app installed. Google Play requires an external deletion path.
- [x] Create a complete data inventory for App Store privacy labels and Google
      Play Data safety, including GitHub identifiers, task metadata, browser
      screenshots, billing records, diagnostics, and retention periods.
- [ ] Decide the mobile billing path before exposing plan upgrades. Confirm
      whether Atlas qualifies as a business/service companion; otherwise use
      store billing for digital features sold in-app.
- [ ] Create production app identifiers, signing keys, store accounts, support
      URL, privacy-policy URL, age rating, export-compliance answers, and review
      credentials.
- [ ] Produce store assets: 1024px icon, Android adaptive icon, launch screen,
      phone/tablet screenshots, short description, and review notes.

## P1 — native shell that earns its place

- [x] Add opt-in browser notifications for local approval requests while the
      local control page is running.
- [x] Add background APNs/FCM push notifications to the native shells.
      Payload construction, registration, revocation and a guard that refuses
      to send a payload carrying a credential or an action digest are in
      `apps/local-control/src/mobile/push.mjs`. The vendor transports are
      injected; neither SDK is a dependency of the daemon.
- [x] Add biometric re-authentication before high-risk approvals.
      `biometric-policy.mjs`. Freshness is capped at two minutes, and a device
      without biometric hardware is told so rather than silently downgraded to
      a tap.
- [x] Store device credentials only in Keychain/Android Keystore.
      `mobile/src/secure-storage.mjs`, with no fallback to web storage and a
      startup guard that stops the app if a credential is found there.
- [x] Register universal/app links for OAuth return and task/approval deep
      links. Links are signed capabilities: one resource, device-bound,
      expiring, and one-time for approvals. Association files are generated.
- [x] Add offline-safe loading, retry, and session-expired states.
      `session-state.mjs`. An approval can never be answered from a cached
      list, and losing the network does not overwrite "revoked" with
      "offline".
- [x] Add native crash reporting with secret redaction and a user-controlled
      diagnostics consent path. Consent defaults to unasked, and the locally
      kept copy is redacted too.
- [ ] Run accessibility, large-text, dark-mode, reduced-motion, rotation, and
      screen-reader checks on physical iOS and Android devices.

## Packaging recommendation

Use a thin Capacitor shell around the existing web UI, with native plugins only
for push, biometrics, secure storage, and deep links. Build Android continuously
from CI. Build and sign iOS on a macOS/Xcode runner; it cannot be completed from
the Windows companion alone. Keep the PWA as the zero-install mobile option.

## Release sequence

1. Complete every P0 item and test account creation/deletion end to end.
2. Add the four native-value features in P1 before Apple review.
3. Run internal distribution: TestFlight and Google Play internal testing.
4. Resolve crashes, policy declarations, and reviewer feedback.
5. Roll out gradually, with the PWA and desktop companion as fallbacks.


## Milestone 8 status — implemented, not yet built

Everything above that is now checked is implemented and covered by tests in
`mobile/` and `apps/local-control/tests/mobile.test.mjs`, and runs in CI.

**None of it has run on a physical device.** The native projects have never
been generated from this repository, so the following remain and need a Mac
with Xcode and a machine with Android Studio:

- [ ] `npx cap add ios` / `npx cap add android`, then build and run on a device.
- [ ] Register the APNs key and the FCM project, and confirm a real push wakes
      a closed app.
- [ ] Publish the association files on the Atlas host and confirm a real
      universal link opens the app rather than Safari or Chrome.
- [ ] Confirm biometric re-authentication on real hardware, including the
      passcode fallback.
- [ ] Accessibility, rotation, dark mode and large-text passes on both
      platforms.
- [ ] Sign in with Apple, which is still the open P0 item above.
