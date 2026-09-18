# Atlas mobile shell

This is the native-value shell for Atlas, not a second product implementation.
It loads the production control plane and owns native push registration and
safe approval deep links. Biometric approval and device credentials must be
implemented with platform Keychain/Keystore plugins before store release;
they must never fall back to `localStorage`.

## Bootstrap

From this directory, run `npm install`, followed by `npx cap add android` and,
on macOS with Xcode, `npx cap add ios`. Commit the generated native projects so
their entitlements, universal links, privacy manifests, and signing settings
remain reviewable. Run `npm run check` and `npm run sync` after web changes.

The production application identifiers are placeholders until the owner
confirms the Apple Developer and Google Play organizations. Do not submit the
shell until every P0 and P1 gate in `../../MOBILE-RELEASE.md` is complete.
