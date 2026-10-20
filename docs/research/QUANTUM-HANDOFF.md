# Quantum execution layer: handoff (WIP for Codex)

Branch: `feat/quantum-execution-layer`. Spec: "ATLAS — Quantum Computing Research
and Integration Initiative" (Phases 1-7). Status: **Phase 1 audit done. No code
written yet.** Nothing on this branch makes any quantum claim.

## Done: Phase 1 audit (2026-10-20)

### Atlas (cornerstonemarketingus/atlas)
I fetched all 231 remote branches with `--depth=50` and searched them with `git grep -i -E
"qiskit|quantum|qaoa|qubit|QUBO|maxcut|statevector|simulated annealing|cortex|physics"`
across main and the ~28 branches most likely to hold research (audit, positioning,
GPU/compute, engineering-plan, and the auto-named claude/* branches).
I also searched commit messages on every ref.

- **No quantum implementation, circuit, simulator, solver or experiment exists on any branch.**
- Only prose mentions, all saying the work was not found:
  - `README.md:130-133`, `TODO.md:228-230`, `apps/web/app/about/page.tsx:48` on main.
    PR #422 (`copy/remove-physics-references`, commit 7045770) removes these. Do not re-add them.
  - `docs/audits/ATLAS-LAUNCH-READINESS.md:81` says "no implementation, branch or document was found".
  - `origin/docs/compute-research-copy-20261020` (commits e0d8873, 4729d61, 024ac7f) contains copy edits about "quantum research claims". It has no code.
- `apps/web/package-lock.json` matched only by accident, inside an integrity hash.
- Cortex in Atlas: commit ff9eb9d, "Drop Cortex/Construction from Atlas scope".
  Cortex is out of scope per `docs/atlas-os/AUDIT.md:337-341` and `docs/atlas-os/BACKLOG.md:226-228`.
- Related existing systems to integrate with (not quantum):
  - `apps/local-control/src/platform/compute/` (GPU leases, RunPod, cost/pricing)
  - `apps/local-control/src/agent/tool-registry.mjs` (tool registry, policy, approvals, credentials by reference, timeouts, retries)
  - `apps/local-control/src/agent/mission-scheduler.mjs`

### Cortex (cornerstonemarketingus/cortex, public)
I shallow-cloned it at HEAD 63fc476 and fetched all 12 branches. A `git grep` for
qiskit/quantum/qaoa/qubit/QUBO/statevector/cirq/pennylane on every branch returned
**no matches**. The only "physics" code is a game-engine rigid-body stub,
`include/cortex/physics/PhysicsEngine.h` and `src/physics/PhysicsEngine.cpp` (227 lines,
optional Bullet). It is classical game physics, not quantum research.

**Conclusion: no existing quantum research exists to preserve. Everything must be built new.**

## Environment findings that affect the design
- Python 3.13, numpy 2.5.3 and scipy 1.18.1 are installed. torch is not installed, so the
  existing `tests/test_agent.py` imports torch and fails at import here.
- **pip cannot reach PyPI in this sandbox.** `pypi.org` does not resolve, so
  qiskit/qiskit-aer could not be installed. The default backend must be a pure-NumPy
  statevector simulator. qiskit stays an optional extra.
- CI runs no Python job at all; every CI job is Node 22 (`.github/workflows/ci.yml`).
  For tests to gate merges, the agent tool path should live in `apps/local-control`
  (Node, run by `npm test`, which picks up `tests/*.test.mjs`). It can shell out to
  Python only when Python is present, or the simulator can be ported to JS.
  Do not edit `.github/workflows/**`, because it is protected.

## Not done (everything else)
1. Subsystem, suggested at `src/atlas_agent/quantum/`:
   - task classifier and eligibility check
   - classical backend
   - NumPy statevector backend
   - optional `qiskit` / `qiskit-ibm-runtime` backend behind `ATLAS_QUANTUM_HARDWARE=1`
   - the hardware backend reads its credential by reference and needs an explicit
     authorization token before any paid job, and never runs in tests
   - job interface with queue, retries, timeout, cancel, and shot/qubit/cost caps
2. Feature flag `ATLAS_QUANTUM_ENABLED`, default OFF.
3. Phase 4 problems (QUBO): MaxCut, constrained resource allocation, construction-project
   scheduling, multi-agent task scheduling. Each is solved three ways: QAOA on the simulator,
   exact brute force, and simulated annealing / greedy + local search.
4. Phase 5 JSON experiment records, one per run, under `docs/research/experiments/`.
   Each record holds: algorithm and version, problem, baseline and settings,
   backend (`"simulation"`), qubits, depth, shots, noise, timings, quality, seeds,
   environment versions, and the reproduction command.
5. Agent tool: register a `quantum.*` tool family. Follow the pattern in
   `apps/local-control/src/agent/tools/business-tools.mjs`: capability `quantum.run`,
   denied until the owner allows it. Register it in `buildToolRegistry()` in
   `apps/local-control/src/main.mjs`, next to `registerBusinessTools`.
   Add an end-to-end test like the HTTP conversation test in
   `apps/local-control/tests/business-tools.test.mjs`.
   Register a Python CLI tool in `src/atlas_agent/cli.py` as well.
6. Python tests under `tests/test_quantum_*.py`, using unittest because pytest is not installed.
7. Final report `docs/research/QUANTUM-REPORT.md`. It may truthfully claim only
   "runs QAOA on a local statevector simulator with verified classical baselines".
   It must not claim speedup or advantage.

## Do not touch
`README.md`, `apps/web/app/about/page.tsx`, `apps/web/app/investors/page.tsx`,
`TODO.md` (being edited in parallel and by PR #422), and CODEOWNERS-protected paths.

## Test commands
- Python: `PYTHONPATH=src python3 -m unittest discover -s tests -p 'test_quantum*.py' -v`
  (the existing `test_agent.py` needs torch)
- Node: `cd apps/local-control && npm test`
- Single file: `node --test tests/quantum-tools.test.mjs`
