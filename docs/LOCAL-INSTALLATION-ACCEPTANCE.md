# Local daemon payload acceptance

Issue #402 repairs two missing runtime dependencies in Windows installation:
`packages/atlas-contracts` and the engineering adapter's shared
`scripts/runner/merge-decision.mjs`. The source installer copies the contracts
and refuses incomplete source packages before installation. MSI staging includes
both dependencies. No merge-policy implementation or signing configuration changes.

`apps/local-control/tests/installed-payload.test.mjs` exercises the actual source
installer and MSI staging, then launches each resulting daemon with isolated data
and checks `/health`. The fixture contains no repository checkout or node_modules.
The source test suppresses optional Ollama discovery; MSI acceptance stubs the
machine dependency scan and stops at the first WiX invocation. It verifies copied
runtime files, not WiX compilation, Authenticode signing or an installed MSI.

Local focused acceptance and release tests passed 14/14 on Windows. Restoring
the original payload scripts makes both startup regressions fail on missing
shared-contract imports. The installer subprocess has a 60-second bound for
Windows file-copy contention; daemon startup retains its 20-second deadline.

Local coder packaging remains unqualified: `scripts/local/run-coder.mjs` expects
`packages/atlas-cli` and builds it using compiler dependencies. This change does
not package that toolchain or establish successful local-model coding. Existing
user data is not migrated, and no customer daemon or signed release is deployed
by these tests.
