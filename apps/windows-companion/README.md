# Atlas Windows Companion

Atlas Companion runs phone-queued browser tasks in a dedicated Microsoft Edge profile. It connects outbound only, exposes no local port, and never attaches to the user's normal browser profile.

## Local-first execution

The companion uses a loopback-only Ollama server by default. Browser state is represented to the model as a bounded accessibility snapshot rather than uploaded screenshots. No hosted model credential is required.

Supported actions are deliberately narrow: navigate, click accessible buttons or links, fill labeled fields, choose options, check boxes, press a key, wait, extract a finding, and finish. Arbitrary scripts, shell commands, downloads, uploads, clipboard access, and hidden DOM mutation are not available.

## Install on Windows

1. In Atlas `/computer`, create a pairing and copy the credential shown once.
2. From a verified Atlas release, run `scripts\windows\Install-AtlasCompanion.ps1`.
3. Paste the credential when prompted.
4. Install the selected Ollama model if the launcher requests it, then open **Atlas Companion** from the Start menu.

The pairing credential is protected with Windows DPAPI for the current Windows account. The launcher decrypts it only into the companion process environment and clears it when the process exits.

## Safety contract

The control plane supplies the workflow policy with every task. The companion independently classifies each proposed action. It pauses for consequential controls such as submit, send, publish, purchase, campaign launch, deletion, and security changes, and for sensitive fields such as passwords, payment data, or government identifiers. One approval authorizes only the exact serialized action and expires after five minutes.

Closing the companion stops local execution. Atlas can also cancel queued or active work from the Computer Operator history.
