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

## P0 — required before store submission

- [ ] Add Sign in with Apple on iOS, or obtain a documented review exception.
      GitHub is currently the only customer login and is a third-party login.
- [ ] Build a deletion processor and operator audit view. The current page
      starts a request but does not yet erase or anonymize records.
- [ ] Add a public web deletion-request URL that works for users who no longer
      have the app installed. Google Play requires an external deletion path.
- [ ] Create a complete data inventory for App Store privacy labels and Google
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

- [ ] Add push notifications for approval requests and completed/failed tasks.
- [ ] Add biometric re-authentication before high-risk approvals.
- [ ] Store device credentials only in Keychain/Android Keystore.
- [ ] Register universal/app links for OAuth return and task/approval deep links.
- [ ] Add offline-safe loading, retry, and session-expired states.
- [ ] Add native crash reporting with secret redaction and a user-controlled
      diagnostics consent path.
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
