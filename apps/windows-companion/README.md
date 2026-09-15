# Atlas Windows Companion

Runs phone-queued Atlas browser tasks in a dedicated Microsoft Edge profile. It connects outbound only; it does not expose a port or attach to your normal browser profile.

## Start

1. Open Atlas `/computer`, create a pairing, and copy the credential shown once.
2. In PowerShell, set `ATLAS_DEVICE_CREDENTIAL` and `OPENAI_API_KEY` for the current user.
3. Run `npm install`, then `npm start` from this directory.

The companion asks the Atlas phone UI for one-time approval before typing, clicking, dragging, or pressing keys. Closing the terminal stops it. This is an early-access browser-only companion; do not use it for financial transactions or password/security-setting changes.
