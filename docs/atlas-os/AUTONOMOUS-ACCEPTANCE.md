# Autonomous golden path: acceptance

`apps/local-control/tests/autonomous-golden-path.test.mjs` is the acceptance
test for "Atlas, running locally on Ollama, works as an autonomous assistant".
It starts the **real daemon** (`apps/local-control/src/main.mjs`) as a child
process, with a temporary data directory and a generated owner token, and
drives it only over its HTTP API, the way the console does. It runs as part
of `npm test` in `apps/local-control`.

By default the model is a **protocol-accurate fake Ollama**
(`tests/helpers/fake-ollama.mjs`). It serves `/api/version`, `/api/tags`,
`/api/show`, `/api/chat` (native, with tools), `/v1/models` and
`/v1/chat/completions` (streaming and non-streaming, with tools), and answers
from a script. With `ATLAS_ACCEPTANCE_REAL_OLLAMA=1` the same journey runs
against a real Ollama instead (see the steps below).

## What it proves (with the fake model)

| Test | What is driven over the API | What must be true |
|---|---|---|
| **A** Conversation | `POST /v1/sessions` with no repository, then a turn "Hello" | The session lands on the `conversation` executor, the model is called at `/v1/chat/completions` (streamed) with the configured model, the reply is the model's, the session is `completed`. Unauthenticated requests get 401. No hosted executor is registered. |
| **B** Repository | A session on a temporary Git repository; the model calls `repository.list` and `repository.read` | Files are discovered and read through the agent's tools; a read of `../outside-secret.txt` is refused (`PATH_ESCAPES_REPOSITORY`) and its contents never appear. `repository.run_tests` is denied by default policy and the refusal names `repository.execute` and where to allow it; with `ask`, the session waits, the approval appears in `GET /v1/approvals`, is approved with `POST /v1/approvals/:id/decision`, is spent once, and the real failing result (`npm-test failed (exit 1)`) is reported. |
| **C** Coding | A `local` (coder) session: "Fix the failing test" | `code.write` is asked for and approved through the approvals API. The real coder (`packages/atlas-cli`, over Ollama's native `/api/chat`) reads the file, calls its edit tool, and fixes the bug in an isolated worktree. The owner's checkout and HEAD are untouched; a portable patch is delivered. |
| **D** No fabricated success | The scripted model edits the file without fixing it and says "Fixed! All tests pass now." | The coder process itself exits as if it succeeded, but the session is `failed`, never `completed`, and its summary names the failing command. |
| **E** Browser | A chat turn that calls `browser.navigate` and `browser.snapshot` on a loopback page | Denied until `browser.control`/`browser.read` are allowed; then the real Chromium opens the page and the snapshot contains its text. When the browser process is killed under Atlas, the next browser call starts a new browser and works. Skipped, with the reason, if Playwright or a browser is not installed. |
| **F** Verification | (inside C and D) | Atlas's own verifier re-runs the repository's test command in the coder's worktree. `GET /v1/sessions/:id` returns `verification: { status, command, cwd, exitCode, outputExcerpt }`. C: `verified`, `npm test`, exit 0, `# pass 1`. D: `failed`, exit 1, the real assertion (`-1 !== 5`). The test re-runs `npm test` in the same worktree itself and checks the evidence matches. |
| **G1** Model unavailable | The fake is shut down (connection refused), then answers HTTP 500 | Chat fails with `MODEL_UNREACHABLE` and "Start Ollama … at http://127.0.0.1:PORT"; a coding session fails with "No self-hosted model server answered … Start Ollama before running Atlas."; HTTP 500 fails with the server's own reason and what to check (`ollama ps`, `ollama pull <model>`, the `ollama serve` log). |
| **G2** Permission denied | `code.write` set to `deny`; then an approval denied | The session fails before the model is called, naming `code.write` and Approvals → Policies; no approval prompt is created. A denied approval ends the session (`Denied: …`) and the work never reaches the model. |
| **G3** Missing repository | Sessions for a missing path, a file, a folder that is not a Git repository, and no repository | Refused before a session exists: 404 `REPOSITORY_NOT_FOUND`, 400 `NOT_A_GIT_REPOSITORY`, 400 `REPOSITORY_REQUIRED`. |
| **H** Persistence | Pair a device, apply a model plan, save policies, start a slow turn, then **SIGKILL** the daemon and start it again on the same data directory | The owner token and the paired-device token still work and a bad token gets 401; the applied model plan and the discovered model endpoint are unchanged; every saved policy (including the `code.write` deny) is unchanged and still enforced; the repository session still points at its folder and paths outside it are still refused; the interrupted session is marked `interrupted` (not left `running`) and its turn is not marked answered; the browser relaunches on the same profile. |
| Local only | The whole run | The daemon is started with a preload (`tests/helpers/loopback-only-guard.mjs`) that refuses and records every TCP connection to a non-loopback host; the log must be empty. Provider keys and proxy variables are removed from the daemon's environment. Every model call reached the fake, used the configured model, and was addressed to loopback. |

## What it cannot prove without a real model

- **Model quality.** The fake answers from a script that knows the right file
  and the right fix. Whether a given local model finds the bug, calls the
  tools with valid arguments, keeps within its context window, or stops when
  it should, is untested here.
- **Real tool-call formats.** The fake emits well-formed tool calls. Real
  models sometimes emit malformed or textual tool calls; the coder has
  recovery for these, but the acceptance test does not exercise it.
- **Real latency and memory.** Timeouts, a model that does not fit in RAM/VRAM,
  and slow first-token times are not simulated (the HTTP 500 case stands in
  for a crashed runner).
- **Child processes' network use.** The loopback guard covers the daemon's own
  process. The coder, `npm test` and the browser are separate processes; they
  start with a filtered environment, and every model call they make is checked
  at the fake, but their other sockets are not intercepted.
- **Windows specifics end to end.** The test runs on Linux here. On Windows,
  the CI job runs the parts that need neither the coder's dependencies nor a
  browser; the manual run below covers the rest.

## Bugs this test found (fixed in the same change)

1. **Fabricated success from the coder** — the coder exits 0 when its agent
   finishes, even when its own report says `Verification: regressed`; the
   daemon reported that as "Local run verified." Atlas now re-runs the
   repository's tests itself (`src/agent/independent-verifier.mjs`) and a
   coding session turn, or an isolated task from `POST /v1/tasks`, is
   `completed` only on exit 0. (Mission lanes, `/v1/missions`, are parts of a
   larger change and are not yet held to this; their patches are still
   checked by the mission evidence verifier.)
2. **`code.write` not enforced for coding sessions** — the local executor never
   consulted policy, so `deny` was ignored and `ask` never produced an approval.
3. **The coder ignored the configured model server** — chat used
   `ATLAS_MODEL_ENDPOINT`; coding always went to `http://127.0.0.1:11434`
   (`src/agent/models/coder-endpoint.mjs`).
4. **Sessions on missing folders** were accepted and failed only after a run
   started (`src/agent/repository-check.mjs`).
5. **Sessions left "running" forever** after the daemon was killed and
   restarted within the 30-second lease (`AgentRuntime.recover`).
6. **Browser tools never found Playwright** from `apps/local-control`, even
   where the browser worker had it (`src/agent/browser/load-playwright.mjs`),
   and a **closed or crashed browser** (or one failed launch) disabled them
   until Atlas restarted.
7. **`repository.run_tests` could not start npm on Windows** (`npm` is a `.cmd`
   shim and Atlas spawns without a shell).
8. HTTP 500 from the model server gave no hint of what to check.

## Run it here

```bash
cd apps/local-control
npm test                                             # includes this test
node --test tests/autonomous-golden-path.test.mjs    # just this test
```

The coding steps need the coder's build dependencies and the browser steps
need Playwright; without them those steps are skipped and say why:

```bash
npm ci --ignore-scripts --prefix packages/atlas-cli
npm ci --ignore-scripts --prefix apps/browser-worker
```

`ATLAS_ACCEPTANCE_REQUIRE_FULL=1` turns those skips into failures.
`ATLAS_ACCEPTANCE_KEEP=1` keeps the temporary directory (daemon log, data
directory, worktrees) for inspection.

## The owner's manual run on Windows with real Ollama

These steps use your real Ollama and a real model. They take a while on a CPU.

1. **Install prerequisites**: Node.js 22.13 or later, Git, and Ollama for
   Windows (from ollama.com). Open a new PowerShell after installing.

2. **Pull the recommended model** (tool calling and coding; about 4.7 GB):

   ```powershell
   ollama pull qwen2.5-coder:7b
   ollama list            # qwen2.5-coder:7b must be listed
   ```

   On a machine with 8 GB of RAM or less, `qwen2.5-coder:1.5b` fits but will
   fail more coding steps. Use the Models page's recommendation if unsure.

3. **Make sure Ollama is serving** on `http://127.0.0.1:11434`:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:11434/api/version
   ```

   If that fails, start it with `ollama serve` (or the Ollama tray app).

4. **Install the coder and browser dependencies** from the repository root
   (no lifecycle scripts run):

   ```powershell
   npm ci --ignore-scripts --prefix packages\atlas-cli
   npm ci --ignore-scripts --prefix apps\browser-worker
   ```

   For the browser steps, either use Edge (already installed) by setting
   `$env:ATLAS_ACCEPTANCE_BROWSER_CHANNEL = "msedge"`, or install Playwright's
   Chromium: `cd apps\browser-worker; npx playwright-core install chromium`.

5. **Start the daemon yourself and try it by hand** (optional, but this is
   what you will use every day):

   ```powershell
   Set-Location .\apps\local-control
   $env:ATLAS_MODEL_ENDPOINT = "http://127.0.0.1:11434/v1"
   npm start
   ```

   In a second terminal, from the repository root:
   `node scripts/local/open-atlas.mjs`. In the console: say "Hello"; then open
   a conversation on a Git repository of yours with **Runs on: local** and ask
   it to fix a failing test. Approve `code.write` under Approvals. The session
   ends `completed` only when Atlas's own re-run of `npm test` passes; open the
   session to see the command, exit code and output it ran. Stop the daemon
   with Ctrl+C before step 6 (the acceptance test starts its own).

6. **Run the acceptance test against real Ollama**:

   ```powershell
   Set-Location .\apps\local-control
   $env:ATLAS_ACCEPTANCE_REAL_OLLAMA = "1"
   $env:ATLAS_ACCEPTANCE_MODEL = "qwen2.5-coder:7b"
   # optional: $env:ATLAS_ACCEPTANCE_OLLAMA_URL = "http://127.0.0.1:11434"
   # optional: $env:ATLAS_ACCEPTANCE_KEEP = "1"   (keeps logs and worktrees)
   node --test --test-reporter=spec tests\autonomous-golden-path.test.mjs
   ```

   In this mode the fake is not started and the daemon is pointed at your
   Ollama. Timeouts are ten times longer. Assertions that depend on what a
   scripted model chose to do are replaced by **honesty** assertions:

   - A: a non-empty reply arrives from your model.
   - B: every tool the model chose to call reports an outcome; if it asks to
     run the tests, the approval flow is exercised.
   - C: whatever the model did, the session is `completed` **if and only if**
     `npm test` passes when the test re-runs it in the worktree, and the
     reported exit code is that exit code.
   - D (lying model) and G1 (model server down / HTTP 500) are skipped: a real
     model cannot be told to lie, and the test does not stop your Ollama.
   - E, G2, G3 and H run as they do with the fake.

7. **What to send back**: the spec output, and with `ATLAS_ACCEPTANCE_KEEP=1`
   the `daemon.log` from the kept folder. A C failure where the session is
   `failed` with the verifier's evidence is an honest result about the model,
   not an Atlas bug; a C or B run where the outcome disagrees with the
   evidence is.
