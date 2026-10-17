# Native mobile compilation gate

The mobile-native workflow builds an Android debug APK and an unsigned iOS simulator app on mobile changes. It uses Java 21/Android SDK36 and the installed Xcode26.3 on the macOS15 runner, with the locked npm dependencies. Native plugins are synchronized before compilation. The iOS app is archived with file permissions preserved; artifacts expire after three days.

These are development build artifacts, not store submissions. Android uses its normal debug signing; no production signing identity is supplied. iOS signing is disabled. No Apple account, upload token, production environment secret or publishing permission is read. Checkout does not persist its read-only repository credential. Build failures remain CI evidence and do not produce a false successful artifact.

The workflow is a protected CODEOWNERS path and requires its configured review before merge. It is initially stacked on the native toolchain repair #316. The unchanged repository workflow checker passes with the actual installed Git Bash executable (the Windows WSL shim cannot run Bash here).

A successful compilation does not prove the app is usable: www still contains the initializing placeholder. Working mobile bootstrap, account authentication/deletion, exact authorized approvals, native push/biometric behavior, real link associations, simulator/device accessibility, release signing, store billing decisions and review metadata remain separate release gates. Never submit these development artifacts as evidence those flows exist.

Runner toolchain inventory checked against [GitHub macOS15](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md); pinned runtime migration follows [Capacitor8](https://capacitorjs.com/docs/updating/8-0) and [8.5 scene lifecycle](https://capacitorjs.com/docs/updating/8-5).
