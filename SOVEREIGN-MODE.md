# Atlas sovereign mode

Sovereign mode means the core product continues to work when every optional
hosted vendor is removed. The customer owns the model, repository, browser,
credentials, logs, and storage. Hosted services are convenience products, not
runtime dependencies.

## Working today

### Local control plane

Start the loopback-only task service:

```text
cd apps/local-control
npm start
```

It creates a local access token on first launch, stores tasks in SQLite under
the user's `.atlas` directory, restores interrupted runs safely after a restart,
and invokes the local coder without a hosted queue. The UI includes local
allow/ask/deny policies, approval decisions, an audit viewer, encrypted
export/import, local model discovery, and revocable phone credentials. It binds
to `127.0.0.1` by default; expose it only through customer-managed HTTPS or a
VPN, never by forwarding the owner-token endpoint directly.

Open `http://127.0.0.1:4317` for the responsive local task interface. Paste the
first-launch token to unlock the current browser tab, then queue and monitor
isolated coding tasks without visiting an Atlas-hosted site.

On Windows, run `scripts\windows\Install-AtlasLocal.ps1` from a verified release
package. It installs a Start menu launcher, checks Node.js and Git, discovers
installed Ollama models, and does not run a remote installer or upload model
data. Release artifacts include a SHA-256 checksum; tagged production releases
must also be Authenticode-signed with the configured organization certificate.

Offline commercial licenses use Ed25519 signatures and require no Atlas server.
Set `ATLAS_OFFLINE_LICENSE_FILE` to the signed JSON license and
`ATLAS_LICENSE_PUBLIC_KEY_FILE` to the vendor public key. Atlas fails closed if
only one file is provided, the signature is invalid, or the license is expired;
community/local mode remains available when neither variable is configured.

Every API-launched task runs in a detached Git worktree under `.atlas/worktrees`
instead of editing the customer's active checkout. Atlas also writes a portable
binary patch under `.atlas/patches`; applying or publishing that patch does not
require GitHub or any particular Git hosting company.

### Local coding

Install Node.js, Git, and Ollama; start Ollama and pull a model:

```text
ollama pull qwen2.5-coder:7b
```

Then run Atlas directly against any local Git checkout:

```text
node scripts/local/run-coder.mjs --repository C:\path\to\project --objective "Fix the failing test and verify the result"
```

The default endpoint is `http://127.0.0.1:11434/v1`. Repository evidence,
tool calls, edits, and validation remain on the machine. Audit records are
written under the user's `.atlas/runs` directory. Use `--help` for model,
context-window, verification-directory, and endpoint options.

### Local computer use

The Windows companion remains the default computer-control executor. Browser
profiles and device credentials stay on the customer's PC; consequential
actions still require approval. Pair this with the local coder to avoid model
and hosted-browser APIs entirely.

## Dependency boundary

| Capability | Sovereign path | Optional hosted path |
| --- | --- | --- |
| Model inference | Ollama or compatible local server | Groq/Anthropic/customer endpoint |
| Code repository | Local Git checkout | GitHub |
| Browser execution | Windows companion | Cloudflare Browser Rendering |
| Audit history | Local SQLite and encrypted export | Cloudflare D1/artifacts |
| Product UI | Local companion UI | Cloudflare Worker |
| Remote access | Customer VPN or self-hosted tunnel | Cloudflare |

## Remaining product work

- [x] Complete approvals, policies, device revocation, and audit browsing in
      the local companion.
- [ ] Add local identity backed by the operating-system account and device
      keychain; GitHub OAuth must be optional.
- [x] Add authenticated AES-256-GCM export/import for the local SQLite state.
- [x] Add GitHub/GitLab/Forgejo publishing adapters on top of the implemented
      host-independent isolated-worktree and portable-patch delivery path.
- [x] Add Windows packaging, Ollama-compatible model discovery, health checks,
      and a Start menu launcher. Model downloads remain an explicit owner action.
- [x] Add one-use, expiring phone pairing codes and separately revocable device
      credentials without transferring the owner token.
- [ ] Add a guided customer-managed HTTPS/VPN enrollment flow. Loopback remains
      the secure default and Atlas does not silently open a LAN port.
- [x] Add release checksums, optional Authenticode signing, and offline Ed25519
      license verification.
- [ ] Build and sign native iOS/Android apps. This requires app identifiers,
      Apple/Google accounts, signing credentials, and a real native biometric
      verification path; browser-only approval must not be labeled biometric.

## Commercial shape

The license should sell orchestration, safety policy, approval UX, auditability,
packaging, and support—not access to a particular model vendor. A customer may
buy Atlas once and supply all compute. Paid Atlas hosting can add managed relay,
backups, team policy, Cloudflare browser minutes, and supported model capacity
without making those services mandatory for the core product.
