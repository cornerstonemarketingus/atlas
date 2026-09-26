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

### Persistent agent runtime

The same process runs the agent runtime, which is what makes Atlas a
conversation rather than a job queue. Sessions persist across restarts, their
events stream live to whoever is attached, and the transcript resumes from
where it stopped when the tab is closed and reopened. Work can be paused,
resumed, cancelled, and retried while it runs, and everything it does lands in
the local audit timeline.

GitHub Actions is one executor adapter here, registered only when this machine
has been given a token for it. A coding session completes locally with no
GitHub credential, no Cloudflare, and no hosted model — only a local
OpenAI-compatible model server such as Ollama.

See [`docs/agent-runtime.md`](docs/agent-runtime.md) for the event contract,
the lease and recovery model, and the HTTP surface.

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

### Local models (Models → Install → Run)

Open **Models** in the local app. Atlas:

- detects what the machine can give a model: NVIDIA (`nvidia-smi`) or AMD
  (`rocm-smi`) GPU memory, Apple Silicon unified memory (about three quarters
  is usable by the GPU), or system memory for CPU inference, plus free memory;
- shows a catalog of open models (Qwen2.5-Coder 1.5B–32B, Qwen3 8B–32B,
  Qwen3-Coder 30B, Devstral 24B, gpt-oss 20B, DeepSeek-R1 14B, Llama 3.1 8B,
  Qwen2.5-VL 7B) with estimated memory at 4-bit quantization, the largest
  context (32k/16k/8k) that fits, and whether each can drive tools;
- recommends a plan for this machine: a **coder** (best coding model with tool
  calls that fits), a **reviewer** (best reasoning model, preferably from a
  different family) and a **fast** model for simple tasks. **Use this plan**
  stores it in `~/.atlas/model-plan.json`;
- **Install** downloads a model with live progress, **Run** loads it with the
  fitting context length and keeps it warm, **Remove** deletes it;
- **Start model server** starts `ollama serve` bound to 127.0.0.1 when no
  server is running, and stops it when Atlas exits. Atlas never stops a server
  it did not start.

The engine today is Ollama; if it is not installed the page links the official
installer. Mixture-of-experts models (Qwen3 30B, Qwen3-Coder 30B, gpt-oss 20B)
run far faster on a CPU than their size suggests, so a 32 GB CPU-only machine
can run a stronger coder than qwen2.5-coder:7b. The API is `/v1/models/hosting`:
anyone signed in can read it, and changing anything needs the owner.

**Routing by difficulty.** With a plan applied (and no
`ATLAS_SELF_IMPROVE_MODEL` override), each self-improvement attempt picks its
model: TODOs and wording-level changes go to the fast model, and failing checks
and ordinary changes go to the coder. Broad changes (refactors, security,
three or more files) and any retry of a task that already failed also go to the
coder, as an escalation. The reviewer uses the plan's reviewer. The ledger
records which model and difficulty each attempt used.

### Self-improvement ("Atlas, improve yourself")

With Ollama running, Atlas can pick and make its own improvements locally:

```text
node scripts/local/self-improve.mjs --iterations 5
```

Each iteration:

1. runs the checks of `--verify-dir` (default `apps/local-control`) on the current HEAD;
2. chooses one task and records why: a failing check first, then a TODO/FIXME
   in a file Atlas may change, then a `- [ ] … (self)` item in TODO.md;
3. makes the change in its own git worktree on `atlas/self-*/builder` with the
   local coder, which verifies and repairs its own edit;
4. re-runs the checks; every check must pass;
5. applies the self-modification policy: at most 8 files and 400 changed
   lines, no CI, runner, policy, approval, auth, sandbox, redaction or
   dependency files, no deleted tests, no drop in test count, nothing
   secret-shaped or risky;
6. asks a separate reviewer model (`--review-model`) to approve the diff;
7. keeps an accepted change as a branch plus a patch under
   `~/.atlas/self-improve/patches` for you to merge (`git merge <branch>`),
   or removes a rejected attempt entirely.

You can also do this from the local app: open **Improve Atlas**, press
**Improve yourself**, watch the progress, and **Merge into my branch** or
**Reject** each accepted change. In chat, asking Atlas to improve itself calls
the `atlas.improve_self` tool, which asks your approval before starting (allow
the `atlas.self_improve` capability to skip that). The daemon reads
`ATLAS_SELF_IMPROVE_BASE_URL`, `_MODEL`, `_REVIEW_MODEL`, `_API_KEY_ENV` and
`_VERIFY_DIR`.

Nothing is merged automatically. `~/.atlas/self-improve/ledger.jsonl` records
every attempt and the streak of consecutive accepted changes. A 7B CPU model
will struggle with long edits; point `--base-url`/`--model` (and
`--api-key-env`) at a stronger OpenAI-compatible model for harder work, and
keep the reviewer on a different model from the builder where you can.

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
- [x] Atlas-managed model hosting: hardware detection (NVIDIA, AMD, Apple
      Silicon, CPU), a model catalog with memory/context fitting, a recommended
      coder/reviewer/fast plan, install/run/remove with progress, a managed
      loopback Ollama server, and routing by task difficulty.
- [ ] Bundle an inference engine (llama.cpp) so Atlas does not need Ollama
      installed separately.
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
