# TODO.md → program map

`TODO.md` is the long-range roadmap (source-of-truth rank 4 in
[`PROGRAM.md`](PROGRAM.md) §2). This file maps every section onto the program
phase that owns it, so no item is lost while the program runs in phase order.
Counts are generated from `TODO.md` as of 2026-09-27 (299 unchecked).

Unchecked items by kind:

| Kind | Unchecked |
|---|---|
| task | 273 |
| rules, not tasks | 13 |
| decisions, not tasks | 6 |
| owner action | 4 |
| another agent's claim | 3 |

"Rules, not tasks" and "decisions, not tasks" are standing constraints written
as checkboxes; they are never "completed", only followed. "Owner action" items
need account settings a coding agent does not have. "Another agent's claim"
follows PROGRAM.md §4.

An item is ticked in `TODO.md` only when it meets PROGRAM.md's IMPLEMENTED
definition (wired, reachable, tested at its real boundary, documented), in the
PR that implements it.

| TODO section | Unchecked | Checked | Kind | Program phase |
|---|---|---|---|---|
| Product thesis | 0 | 0 | context | — |
| Non-negotiable engineering rules | 5 | 7 | rules, not tasks | §7–8 (standing rules) |
| Phase 0 — validated local repository intelligence | 0 | 18 | task | 2.3 |
| Phase 1 — deterministic code navigation | 0 | 0 | task | 2.3 |
| Phase 1 — deterministic code navigation › Shared repository primitives | 5 | 8 | task | 2.3 |
| Phase 1 — deterministic code navigation › Language intelligence | 16 | 1 | task | 2.3 (TS/JS, Python only; other languages deferred) |
| Phase 1 — deterministic code navigation › Repository understanding | 7 | 1 | task | 2.3 |
| Phase 2 — safe tool runtime | 0 | 0 | task | 2.5 |
| Phase 2 — safe tool runtime › Capability and policy model | 5 | 6 | task | 2.5 / 3.2 |
| Phase 2 — safe tool runtime › Filesystem and editing tools | 8 | 2 | task | 2.5 |
| Phase 2 — safe tool runtime › Command runtime | 6 | 4 | task | 2.5 |
| Phase 2 — safe tool runtime › Validation tools | 9 | 1 | task | 2.4 |
| Phase 3 — provider-neutral intelligence layer | 0 | 0 | task | 1.1–1.3 |
| Phase 3 — provider-neutral intelligence layer › Core provider contract | 5 | 5 | task | 1.1 |
| Phase 3 — provider-neutral intelligence layer › Model providers | 9 | 1 | task | 1.3 / 4.x |
| Phase 3 — provider-neutral intelligence layer › Atlas free/trial model | 9 | 0 | task | 1.3 + First external user |
| Phase 3 — provider-neutral intelligence layer › Context engineering | 8 | 0 | task | 1.4 |
| Phase 4 — single-agent coding loop | 0 | 0 | task | 2.4 / 2.6 |
| Phase 4 — single-agent coding loop › Hosted control plane foundation | 16 | 12 | task | 3.x + First external user |
| Phase 5 — Git engineering workflows | 12 | 2 | task | 2.6 |
| Phase 6 — development and browser workflows | 9 | 0 | task | 3.3 / 3.5 |
| Phase 7 — persistent repository memory | 10 | 0 | task | 1.4 / 2.3 |
| Phase 8 — multi-agent engineering orchestration | 12 | 0 | task | 1.2 / 3.1 |
| Phase 9 — local CLI product | 10 | 0 | task | First external user |
| Phase 10 — web coding workspace | 11 | 0 | task | 3.1 / 3.7 |
| Phase 11 — desktop IDE | 8 | 0 | task | Deferred (after First external user) |
| Phase 12 — cloud agent platform | 9 | 0 | task | First external user / Deferred |
| Phase 13 — reusable Atlas platform and ecosystem | 10 | 0 | task | Deferred |
| Phase 14 — enterprise security, privacy, and compliance | 13 | 0 | task | 3.2 + First external user; rest deferred |
| Phase 15 — budgets, billing, and commercial controls | 10 | 2 | task | 3.8 + First external user |
| Phase 16 — quality, evaluation, and observability | 10 | 0 | task | 2.1 / 2.2 / 3.1 |
| Phase 17 — advanced and differentiating capabilities | 17 | 0 | task | Deferred (metrics-gated) |
| Product foundations required across all phases | 0 | 0 | task | cross-cutting |
| Product foundations required across all phases › Data and API contracts | 4 | 0 | task | 1.1 / cross-cutting |
| Product foundations required across all phases › Reliability | 4 | 0 | task | 1.2 / 1.3 |
| Product foundations required across all phases › Session evidence and audit | 0 | 3 | task | 3.1 / 3.2 |
| Product foundations required across all phases › Accessibility and internationalization | 4 | 0 | task | 3.x (accessibility); i18n deferred |
| Product foundations required across all phases › Documentation and developer experience | 5 | 0 | task | cross-cutting |
| Remaining limitations (reviewed 2026-09-26) | 0 | 0 | context | — |
| Remaining limitations (reviewed 2026-09-26) › Owner (settings only; no code) | 4 | 0 | owner action | Owner |
| Remaining limitations (reviewed 2026-09-26) › Copilot (hosted web app) | 3 | 0 | another agent's claim | Copilot (do not take without a stale-claim comment) |
| Remaining limitations (reviewed 2026-09-26) › Claude (local daemon and agent runtime) | 6 | 1 | task | per item; see PROGRESS.md |
| Remaining limitations (reviewed 2026-09-26) › Queued (larger product work, one GitHub issue each) | 6 | 0 | task | per item |
| Immediate next assignments | 0 | 1 | superseded by PROGRAM.md | — |
| Explicitly deferred decisions | 6 | 0 | decisions, not tasks | Deferred |
| Definition of done for any checked item | 8 | 0 | rules, not tasks | §2 IMPLEMENTED definition |
