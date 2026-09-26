# Copilot plan: from chatbot to agent computer

**Goal.** Atlas should act like a computer that thinks: it looks things up, runs things, remembers, splits big jobs across parallel agents, fixes its own failures and ships. It should not feel like a chat box that only answers. This plan divides the remaining work into issues that GitHub Copilot's coding agent can finish one pull request at a time. Every Copilot task also reads `.github/copilot-instructions.md`, which covers layout, checks, security rules and conventions.

## Where Atlas stands (September 26, 2026)

**Works end to end on `main` (after #81):**
- **Chat-first UI.** Atlas decides what to do.
- **Visible work.** Thinking and live steps show in the chat.
- **Chat tools.** Atlas can read web pages, search the web and read connected repositories for up to 6 rounds per reply.
- **Tasks from chat.** Chat starts coder, inspect, debug and computer tasks.
- **Coder runs** open pull requests that merge once CI passes.
- **Workspaces.** Tenant model and memory of past conversations.
- **Local daemon.** Container and namespace sandboxes, orchestrator, MCP over HTTP, desktop operator groundwork.

**The 10 gaps,** in order of product impact, each with its issues:

| # | Gap | Issues | Wave |
|---|-----|--------|------|
| 1 | Project Genesis: from a prompt to a deployed app | #94 → #95 → #96 (split from #73), #74 | 4 |
| 2 | Multi-agent missions: a supervisor over parallel agents | #87 | 2 |
| 3 | Computer control that is ready for everyday use | #91 | 3 |
| 4 | The complete coding loop: CI and review awareness, then self-repair | #83 → #86 | 1 → 2 |
| 5 | Persistent engineering memory | #82 | 1 |
| 6 | Sandboxes that can do real dev work (git, installs, dev servers) | #92 (after #72) | 3 |
| 7 | A universal model router with fallback | #84 | 1 |
| 8 | An ecosystem of MCP servers and Skills | #93 | 3 |
| 9 | Automations as a persistent runtime | #75 (Copilot PR #78 in progress) | running |
| 10 | One unified conversation UI | Done in #79/#80/#81; #88 and #89 extend it | 2 |

The following also make Atlas feel more capable in chat:
- #88: file uploads and vision.
- #89: exact computation, and previews of what Atlas builds.
- #90: evals that measure whether Atlas is getting smarter.
- #85: reconcile the docs with the code.

Already queued: #75 automations, #76 CSP, #68 rate limiting, #61 mobile (open Copilot PRs #78, #77, #69, #61).

## Waves

Copilot works best on 3–4 issues at a time that don't touch the same files. Start a wave once the previous wave's pull requests are merged, so each new branch starts from current code.

1. **Wave 1** (now, after #81 merges): #82 memory, #83 CI and pull-request tools, #84 model router, #85 docs.
   - #82 and #83 both add tools to `instant-tools.mjs`. Expect a small merge conflict between them.
   - Merge whichever finishes first, then ask Copilot on the other pull request to "merge main and resolve conflicts".
2. **Wave 2:** #86 pull-request steward, #87 missions, #88 uploads, #89 compute and artifacts, #90 evals.
   - Run #90 early, so every later change is measured.
3. **Wave 3** (local daemon): #91 computer control, #92 sandbox git and dev servers, #93 MCP servers and Skills. These touch `apps/local-control`, which is separate from the waves above, so they can overlap with wave 2.
4. **Wave 4** (Genesis): #94 → #95 → #96 in order, then #74 visual builder.

## How to feed Copilot

- **Start a task.** On an issue, choose Assignees → Copilot. You can also ask Claude Code or Atlas to assign it.
- **Steer it.** Comment on Copilot's pull request with `@copilot <instruction>`. Examples: "merge main and fix conflicts", "tests for X are missing", "CI failed in apps/web lint, fix it". Copilot only reacts to comments that mention it.
- **Unstick a stalled draft.** Open the pull request. If its checks are green and it looks complete, mark it "Ready for review" and merge it. If it stopped partway, comment `@copilot continue: <what's left>`. PRs #69, #77 and #78 are in this state.
- **Review before merging.** Check the Tests section of the description, that CI is green, and that there is no new dependency without a stated reason. Atlas's own pull-request steward (#86) will take over repairs for pull requests Atlas opens itself.
- **Keep `copilot-instructions.md` current.** When you correct Copilot on the same thing twice, add a rule to that file.

## After each wave, try these in chat

- "Why did CI fail on my last PR, and fix it." This needs #83 and #86.
- "Remember we deploy on Fridays only." Then, in a new chat, ask "can we deploy today?" This needs #82.
- "Audit the web app and fix the 3 worst problems." This needs #87.
- Drop a CSV and ask "chart revenue by month." This needs #88 and #89.
- "Build me a CRM for roofing contractors." This needs #94 to #96.
