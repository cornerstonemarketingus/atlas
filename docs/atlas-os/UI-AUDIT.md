# Atlas web experience audit

Audit date: 2026-09-24. Scope: `apps/web/app` in PR #55.

Follow-up: the shared shell and Tasks inbox were rebuilt on the UI branch after
the initial audit. The changes continue to use the existing APIs and do not
invent task progress or approval state.

## Findings

| Surface | Before | Current path | Follow-up |
|---|---|---|---|
| `/` chat | Questions were sent only to `/api/chat`; the system prompt told users to leave Chat for any real work. | Ordinary questions still use `/api/chat`. Clear project-work language is classified into `inspect`, `debug`, or `coder` and sent to the existing `POST /api/tasks` dispatcher. | Add model-assisted intent confirmation once the product has a reliable planning response contract. |
| Chat history | Reopening a thread loaded messages, but task activity was not shown in the chat surface. | Conversation messages and task records are restored; live task data is merged from `/api/tasks` and refreshed while open. | Add streamed model responses when the provider contract supports them. |
| Primary navigation | `Build` and `Automation` presented internal product modes as the main way to start. | Primary labels are `Chat`, `Projects`, and `Tasks`; Connections and Settings remain utility destinations. | Add a dedicated project list when project records exist beyond the repository picker. |
| Project task composer | The selector used `Plan` and `Build`, which implied modes users had to understand first. | Advanced project work uses `Review`, `Debug`, and `Make changes`. The existing task API and approval boundaries are unchanged. | Keep this surface advanced; do not duplicate it in chat. |
| Sign-in gate | Copy led with “AI computer operator + autonomous builder” and promised broad outcomes before a user started. | Copy explains chat, project help, proposed changes, and user control in ordinary language. | Review marketing-only pages separately for the same terminology. |
| Shared shell | Navigation repeated internal hints and exposed project/theme controls globally. | Navigation is concise; conversation search lives with chats; theme selection lives in Settings. | Add richer project context only where a project is active. |
| Tasks | Browser workflows were the primary landing experience and approvals were embedded above the setup wizard. | Tasks opens with Needs your attention, Running, and History views; approvals remain backed by `/api/computer/approvals`. | Add dedicated task detail routes when the task API exposes stable deep links. |

## Acceptance criteria for this increment

- A signed-in user can type a question in Chat and use the existing conversation endpoint.
- A signed-in user can type a clear project request and invoke the existing task dispatcher without opening Projects first.
- The selected project is reused from the existing project switcher.
- Task history survives refresh through the existing conversation API.
- Live task links and status come from existing task data, not simulated timers.
- No merge, deployment, credential change, or production action is performed by the UI change.
- Tasks shows only statuses and approvals returned by `/api/computer/tasks` and related APIs.

## Known limits

- The task classifier is intentionally conservative and keyword-based. Ambiguous requests remain ordinary chat messages.
- Chat requires the configured model endpoint for questions; project tasks require the configured GitHub or private dispatcher.
- Browser, desktop, and connector work remain behind their existing task surfaces and approval controls.
- Full browser acceptance could not run in this environment because the web dependency installation exhausted available disk space before completing.