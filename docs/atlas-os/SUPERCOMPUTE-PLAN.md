# Atlas Supercompute: plan of additions and pending work

Status: plan (2026-10-20). Owner question: "How do we make Atlas a
supercomputer?" This document audits what exists, what is in open PRs, and
what still has to be built. It respects the phase order and gates in
[`docs/PROGRAM.md`](../PROGRAM.md): nothing here skips an exit gate, and items
that PROGRAM.md lists as **DEFERRED (metrics-gated)** stay gated, with the
metric that would ungate them stated below.

## 1. What "supercomputer" means for Atlas

A classical supercomputer is many tightly coupled processors, scheduled as one
machine. Atlas will not own a data-center cluster. Its version is a
**federated, elastic compute fabric**: every machine and service Atlas can use
is one scheduled pool, and a single mission can fan out across all of it.

| Layer | Pool members |
|---|---|
| Owned | The owner's PC, any enrolled Atlas Node (home machines, spare laptops, office boxes), Oracle Always Free |
| Rented on demand | RunPod Serverless GPUs, later RunPod Pods and Instant Clusters, Modal |
| Hosted | Cloudflare Workers, Cloudflare Sandboxes, GitHub Actions runners |
| Inference | Local models plus every vendor in the inference fabric catalog |

One scheduler places each job on the cheapest eligible member that meets its
capability, trust, deadline and budget, and waits instead of failing when the
pool is full.

### Claim ladder (what Atlas may say, and when)

| Stage | Claim | Evidence required |
|---|---|---|
| Today | Budget-capped GPU compute plane, built and tested against fakes | Existing tests (COMPUTE.md) |
| S0 done | Runs jobs on rented cloud GPUs and on the owner's own machines | First real RunPod job and a real Atlas Node job, with bills reconciled |
| S1 done | One scheduler across owned, rented and hosted compute | A mission whose jobs land on three different provider kinds, with receipts |
| S3 done | Fans one workload out across N machines | Measured wall-clock speedup vs one machine on a published benchmark |
| S4 done | Multi-GPU / multi-node distributed jobs | A distributed training or inference run with logged topology, throughput and cost |

Do not use the word "supercomputer" in public copy before S3 is measured.

## 2. What already exists on main

| Capability | Code | State |
|---|---|---|
| Compute plane: leases, budget reservation, max lifetime, idle timeout, reconciler, monthly cap | `apps/local-control/src/platform/compute/` | Built and tested; off by default (cap 0) |
| RunPod Serverless adapter with crash-safe journal and derived billing | `compute/runpod.mjs`, `service.mjs` | Built; never run against a real account |
| Job sizing (VRAM floors by kind; run locally if the local GPU fits) | `compute/requirements.mjs`, `agent/models/hardware.mjs` | Built |
| Federated worker registry (untrusted → enrolled → verified → revoked) | `platform/workers/registry.mjs` | Built |
| Parallel execution: mission DAG with bounded concurrency, coder lanes in worktrees, agent family graph (16 concurrent) | `platform/orchestrator/dag.mjs`, `platform/family/` | Built, single machine |
| Local model hosting (catalog fit to hardware, install, warm, role plan) | `agent/models/hosting.mjs` | Built |
| Shared inference governor (reserve/release across chat, coder, daemon) | `packages/atlas-inference`, `apps/web/app/api/inference/governor/` | Built |
| Render runner (Blender, ffmpeg) in containers | `platform/render/` | Built, local containers only |
| Task budgets, per-task observability and cost rollups | `platform/budget.mjs`, `platform/workers/observability.mjs` | Built |

## 3. Open PRs that are building blocks (merge order)

| Order | PR | What it adds | Blocker |
|---|---|---|---|
| 1 | #407 Atlas Node | Bring-your-own machine as a $0 provider: enrollment, job claims, leases, digest-checked uploads, `NodeProvider` | Mergeable; needs review |
| 2 | #397 Inference fabric A1 | Every free vendor in one catalog with enforced data trust; refusals route on | Mergeable; needs review |
| 3 | #406 Eval sharding | Shards the eval suite; first fan-out workload | Check CI |
| 4 | #400 Cloudflare Sandboxes | Cloud environments with snapshot/restore and local↔cloud migration | Blocked: needs Workers Paid + deploy (owner) |
| 5 | #372, #291, #335 | Durable execution claims, cloud mission persistence, bounded cloud observation | Review gates |

Issues that own the remaining work: #353 (GPU compute manager), #352
(universal execution), #351 (persistent environments), #354 (artifacts),
#127 (inference control plane).

## 4. Additions, phased

Each stage lists deliverables and an exit gate. Stages follow PROGRAM.md;
S1–S3 fit inside Phases 3–4 and the First External User milestone. S4 is the
DEFERRED list and stays gated.

### S0 — Light up real compute (owner actions + small wiring)

1. Merge #407 and #397.
2. **Owner:** RunPod account, credit, worker image, Serverless endpoint,
   `ATLAS_GPU_MONTHLY_CAP_USD` above 0 (COMPUTE.md "RunPod setup").
3. Run the first real RunPod job; compare the derived bill with RunPod's
   billing page; fix the fake if response shapes differ.
4. Enroll one real Atlas Node (the owner's PC) and run a CPU render on it.
5. `GET /api/compute/spend` route and a dashboard tile (COMPUTE.md follow-up).
6. Node console page: mint, approve, revoke, live jobs (#407 follow-up).

**Exit gate:** one real paid GPU job and one real node job, both settled,
audited and visible in the dashboard. Spend never exceeds the cap in a
failure-injection test against the live endpoint with a $1 cap.

### S1 — One scheduler across the whole pool ("Compute Fabric")

The compute plane already has a provider interface; the inference fabric has a
vendor catalog. S1 unifies them.

1. **Capacity catalog.** Every pool member is a record: kind, capabilities
   (CPU cores, RAM, GPU/VRAM, tools such as Blender, ffmpeg, Docker, CUDA),
   trust tier (`private` / `vendor` / `trains`), price model, live health.
   Sources: worker registry, RunPod pricing table, inference catalog,
   environment kinds.
2. **Placement policy.** `place(job) → member` scores eligible members by
   trust (hard filter), capability (hard filter), budget (hard filter),
   then cost, queue wait, data locality and deadline. Policies mirror
   PROGRAM.md 4.6: `LOCAL_ONLY`, `OWNED_FIRST`, `FREE_FIRST`, `BALANCED`,
   `FASTEST`.
3. **One queue, "schedule, don't fail".** Jobs that fit nowhere enter
   `WAITING_FOR_CAPACITY` with a stated reason and an earliest-retry time,
   reusing the governor's states. No job is dropped.
4. **Remote data plane.** Content-addressed input/output store (R2 or
   S3-compatible) with sha256 manifests, so jobs can run where their inputs are
   not. Unblocks GPU render routing (COMPUTE.md follow-up: inputs, request
   size, remote-GPU render contract — the contract change is a protected
   review).
5. **GPU render routing** through `ComputeManager.runJob` using the data plane.
6. **Mission integration.** DAG lanes and family-graph children request
   capacity through `place()` instead of assuming the local machine.

**Exit gate:** one mission whose jobs run on at least three provider kinds
(local, node, RunPod or sandbox), each with a receipt, and a test proving a
job with no eligible member waits and later completes.

### S2 — Inference on the fabric (PROGRAM.md Phase 4)

1. Phase 4.1–4.5: `AtlasHardwareProfile`, model registry, `AtlasTokenizer`,
   `NativeBackend` (llama.cpp or mistral.rs bindings), PROOF 1 and PROOF 2.
2. Inference jobs on Atlas Nodes, reusing #407's enrollment, claim and lease
   path (PROOF 4, Phase 4.9: app on A, inference on B).
3. Scale-to-zero private inference on rented GPUs (Modal or RunPod vLLM
   worker) registered as a `private` source (inference fabric phase C).
4. Agent-aware scheduling (4.7): prefix grouping for cache reuse, model
   affinity, deadline classes. PROOF 3: many agents saturate into WAITING,
   not errors.
5. Mutual TLS or certificate pinning for node transport (closes a #407 known
   limitation before nodes carry repository code).

**Exit gate:** PROGRAM.md Phase 4 gate (offline local tool loop) plus PROOF 4.

### S3 — Fan-out: one workload across many machines

1. **Map/reduce job type.** A job declares shards; the scheduler places shards
   across members; a reducer merges results; failed shards retry elsewhere
   once (the #407 lease re-queue rule).
2. First workloads, all already parallel by nature:
   - eval suite shards (#406) across nodes and runners;
   - test-suite sharding for large repositories in coder runs;
   - frame-parallel rendering (one Blender frame range per member);
   - competing-version coder lanes on remote sandboxes instead of local
     worktrees.
3. **Checkpointing** for long jobs so a preempted or revoked member resumes
   from the last checkpoint on another member.
4. **Fabric dashboard:** live pool size, utilization, queue depth, spend,
   and per-mission placement map.
5. **Benchmark harness:** wall-clock and cost for 1 vs N members on a fixed,
   published workload set.

**Exit gate:** measured speedup on the benchmark (e.g. eval suite or a
render) of at least 3× wall-clock on 4 members, with cost recorded. This is
the first point at which "distributed compute" claims are allowed.

### S4 — Tightly coupled scale (DEFERRED in PROGRAM.md; metrics-gated)

Items: multi-GPU single job, multi-node training and inference, distributed
KV, disaggregated prefill/decode, hosted GPU fleet, custom kernels.

Proposed ungating metrics (owner decides):
- a customer or internal workload whose S3 fan-out cannot meet its deadline
  or memory need on one GPU;
- GPU spend on the fabric sustained above a set monthly amount, where a
  reserved fleet would cost less than on-demand.

When ungated:
1. RunPod Pods and **Instant Clusters** adapter. Instant Clusters provide
   2–8 nodes (16–64 GPUs) of A100/H100/H200/B200 in one data center with
   1600–3200 Gbps interconnect and support PyTorch distributed, Slurm and
   Ray. Same lease, cap and reconciler rules; worst-case reservation is
   `nodes × GPUs × rate × max lifetime`.
2. Launch templates: `torchrun` for distributed training and fine-tuning,
   Ray + vLLM for multi-node inference, managed Slurm for batch.
3. Topology-aware placement (keep a job inside one cluster; never stretch
   a tightly coupled job across the WAN fabric).
4. Fleet economics: reserved vs on-demand break-even report from real spend.

PROGRAM.md §8 still applies: no training a model from scratch and no custom
kernels before native generation works.

## 5. Invariants every stage keeps

- **Money:** every paid placement reserves its worst case before it starts;
  the monthly cap is checked atomically; unknown bills settle at full
  reservation; providers enforce max lifetime themselves.
- **Trust:** placement filters by data trust tier first. Repository code
  never reaches a `trains` member without the owner's explicit consent.
- **Security:** nodes start untrusted and only the owner enrolls them;
  container-only execution, never host fallback; digest-checked inputs and
  outputs; tenant isolation on every queue, lease and artifact.
- **Honesty:** placement receipts record where each job ran and what it cost.
  Public claims follow the claim ladder in §1.

## 6. Owner actions (cannot be done by an agent)

| Action | Unblocks |
|---|---|
| Review and merge #407, #397 | S0 |
| RunPod account, worker image, endpoint, cap > 0 | S0 real GPU jobs |
| Workers Paid plan and deploy | #400 cloud sandboxes |
| Object storage bucket (R2) and credentials | S1 data plane, GPU render routing |
| Approve the remote-GPU render contract (protected path) | S1 GPU render routing |
| Pick S4 ungating metrics | S4 |

## 7. Proposed issues

One issue per workstream (PROGRAM.md §4):

1. S0 — First real RunPod and Atlas Node jobs, spend route, node console.
2. S1 — Capacity catalog and placement policy.
3. S1 — Remote data plane and GPU render routing.
4. S2 — Inference on Atlas Nodes (PROOF 4) and node mTLS.
5. S3 — Map/reduce job type, checkpointing and the fabric dashboard.
6. S3 — Distributed benchmark harness.
7. S4 — Instant Clusters adapter and launch templates (blocked on gate).

## Sources

- [RunPod Instant Clusters overview](https://docs.runpod.io/instant-clusters/overview) (read 2026-10-20)
- Repository: `docs/atlas-os/COMPUTE.md`, `docs/PROGRAM.md`, PRs #397, #400, #406, #407
