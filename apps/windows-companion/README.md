# Atlas Windows Companion

Atlas Companion runs phone-queued browser tasks in a dedicated Microsoft Edge profile. It connects outbound only, exposes no local port, and never attaches to the user's normal browser profile.

## Local-first execution

The companion uses a loopback-only Ollama server by default. Browser state is represented to the model as a bounded accessibility snapshot rather than uploaded screenshots. No hosted model credential is required.

Supported actions are deliberately narrow: navigate, click accessible buttons or links, fill labeled fields, choose options, check boxes, press a key, wait, extract a finding, and finish. Arbitrary scripts, shell commands, downloads, uploads, clipboard access, and hidden DOM mutation are not available.

## Install on Windows

1. In Atlas **Automation → Pair a computer**, create a pairing and download the `.atlas-pair` file shown once.
2. From a verified Atlas release, run `scripts\windows\Install-AtlasCompanion.ps1 -PairingFile <downloaded-file>`.
3. The installer validates the HTTPS deployment, protects the credential with Windows DPAPI, and deletes the plaintext handoff file. Copy/paste remains available only as a fallback.
4. Install the selected Ollama model if the launcher requests it, then open **Atlas Companion** from the Start menu.

Run `Test-AtlasCompanion.ps1` at any time for a JSON preflight report. It reports installed tools, memory, models, and pairing state but never prints the pairing credential or local profile. When no model is specified, the launcher chooses an installed Qwen coder model sized conservatively for system memory (3B below 14 GiB, 7B from 14 GiB, and 14B from 30 GiB).

The installer can also open a structured local profile for career and business facts. It is encrypted for the current Windows account with DPAPI and supplied only to the loopback Ollama process. Run `Configure-AtlasProfile.ps1` again whenever those facts change.

The pairing credential is protected with Windows DPAPI for the current Windows account. The launcher decrypts it only into the companion process environment and clears it when the process exits.

## Safety contract

The control plane supplies the workflow policy with every task. The companion independently classifies each proposed action. It pauses for consequential controls such as submit, send, publish, purchase, campaign launch, deletion, and security changes, and for sensitive fields such as passwords, payment data, or government identifiers. One approval authorizes only the exact serialized action and expires after five minutes.

Closing the companion stops local execution. Atlas can also cancel queued or active work from the Computer Operator history.

## Release and recovery

`scripts\windows\New-AtlasCompanionPackage.ps1` produces a versioned source bundle and adjacent SHA-256 checksum. Pass `-CertificateThumbprint` (or set `ATLAS_WINDOWS_CERTIFICATE_THUMBPRINT`) to Authenticode-sign every included PowerShell entry point before packaging. A public release must be signed by a trusted code-signing certificate; the repository cannot manufacture that identity.

The Start-menu shortcut uses a supervisor with capped exponential restart and a 5 MiB rotating local log at `%LOCALAPPDATA%\Atlas Companion\logs`. Network polling also backs off to avoid a tight retry loop. Persistent startup failures stop after five restarts and preserve the log for diagnosis.
