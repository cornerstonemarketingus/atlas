/**
 * The local Atlas console, served by the daemon on loopback.
 *
 * Nine sections — Home, Missions, Agent families, Computer, Projects,
 * Knowledge, Connections, Approvals, Settings — over the daemon's own APIs.
 * The page ships under a strict CSP (no inline script or style), so every
 * dynamic value is escaped with esc() and nothing is styled inline.
 */
export const LOCAL_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#0d120f">
<title>Atlas</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app.css"></head>
<body>
<a class="skip" href="#content">Skip to content</a>
<div class="app">
<aside class="rail" aria-label="Atlas">
 <a class="brand" href="#/home"><span class="mark" aria-hidden="true">A</span><span><strong>Atlas</strong><small>on this computer</small></span></a>
 <nav class="nav" aria-label="Sections">
  <a href="#/home" data-nav="home"><span class="ico" aria-hidden="true">⌂</span>Home</a>
  <a href="#/command" data-nav="command"><span class="ico" aria-hidden="true">▦</span>Command center</a>
  <a href="#/automations" data-nav="automations"><span class="ico" aria-hidden="true">⟳</span>Automations</a>
  <a href="#/build" data-nav="build"><span class="ico" aria-hidden="true">✚</span>Build</a>
  <a href="#/missions" data-nav="missions"><span class="ico" aria-hidden="true">◎</span>Missions</a>
  <a href="#/improve" data-nav="improve"><span class="ico" aria-hidden="true">↻</span>Improve Atlas<span class="badge" id="improve-badge" hidden></span></a>
  <a href="#/models" data-nav="models"><span class="ico" aria-hidden="true">◈</span>Models</a>
  <a href="#/families" data-nav="families"><span class="ico" aria-hidden="true">⋔</span>Agent families</a>
  <a href="#/computer" data-nav="computer"><span class="ico" aria-hidden="true">▣</span>Computer</a>
  <a href="#/projects" data-nav="projects"><span class="ico" aria-hidden="true">▤</span>Projects</a>
  <a href="#/knowledge" data-nav="knowledge"><span class="ico" aria-hidden="true">✦</span>Knowledge</a>
  <a href="#/connections" data-nav="connections"><span class="ico" aria-hidden="true">⇄</span>Connections</a>
  <a href="#/approvals" data-nav="approvals"><span class="ico" aria-hidden="true">✓</span>Approvals<span class="badge" id="approvals-badge" hidden></span></a>
  <a href="#/settings" data-nav="settings"><span class="ico" aria-hidden="true">⚙</span>Settings</a>
 </nav>
 <div class="rail-foot"><span class="dot" id="health-dot" aria-hidden="true"></span><span id="health">Checking model…</span></div>
</aside>
<div class="scrim" id="scrim" hidden></div>
<div class="main">
 <header class="topbar">
  <button type="button" class="icon-btn" id="menu" aria-label="Open sections" aria-controls="content">☰</button>
  <h1 id="view-title">Home</h1>
  <button type="button" class="icon-btn" id="theme" aria-label="Switch between light and dark">◐</button>
 </header>
 <p id="notice" class="toast" role="status" aria-live="polite"></p>
 <section class="panel unlock" id="unlock" aria-labelledby="unlock-heading">
  <h2 id="unlock-heading">Unlock Atlas</h2>
  <p class="hint">On the computer running Atlas, start it from the Start menu or run <code>node scripts/local/open-atlas.mjs</code> to sign in as this computer's account automatically. Or paste the owner token; it stays in this browser tab only.</p>
  <label>Access token<input id="token" type="password" autocomplete="off" placeholder="Access token"></label>
  <button id="save-token">Unlock this tab</button>
  <form id="pair-form" class="pair-form"><h3>Pair this phone or laptop</h3><p class="hint">On the computer running Atlas, open Settings → Reach Atlas from your phone → Pair a device, then enter the code here.</p><label>Pairing code<input id="pair-code-input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label><label>Name for this device<input id="pair-name" maxlength="80" value="My phone"></label><button>Pair</button><p id="pair-status" class="hint" role="status" aria-live="polite"></p></form>
 </section>
 <main id="content" tabindex="-1">

 <section class="view" data-view="home" aria-labelledby="home-heading">
  <div class="hero"><p class="eyebrow">BUILD IT. RUN IT. GROW IT.</p><h2 id="home-heading">What should Atlas do?</h2>
  <p class="lede">Talk it through here, or hand a goal to the team. Atlas plans the work across its agent organization, runs each step with the tools you have allowed, checks the result, and asks you before anything consequential.</p></div>
  <div class="grid-home">
   <div class="panel chat" aria-labelledby="chat-heading">
    <div class="section-title"><h3 id="chat-heading">Conversation</h3><select id="session-picker" aria-label="Conversation"><option value="">New conversation…</option></select></div>
    <div id="transcript" class="transcript" aria-live="polite"><p class="empty">Unlock this tab, then send a message to start.</p></div>
    <p id="run-status" class="hint" role="status"></p>
    <form id="turn-form"><label class="sr" for="turn-text">Message</label><textarea id="turn-text" maxlength="10000" placeholder="Ask a question, or describe what you want done"></textarea>
     <div class="composer-bar"><div class="actions"><button>Send</button><button type="button" class="secondary" id="to-team" title="Plan this across the agent organization as a mission">Give to the team</button><button type="button" class="ghost" id="dictate">Dictate</button></div>
      <label class="attach">Attach<input id="attachments" type="file" multiple accept="text/*,.md,.json,.csv"></label></div>
     <details class="more"><summary>Conversation controls and settings</summary>
      <div class="actions"><button type="button" class="secondary" id="pause">Pause</button><button type="button" class="secondary" id="resume">Resume</button><button type="button" class="secondary" id="stop">Stop</button><button type="button" class="secondary" id="retry">Retry</button><button type="button" class="secondary" id="regenerate">Regenerate</button><button type="button" class="secondary" id="edit-last">Edit last</button></div>
     </details>
    </form>
    <details class="more"><summary>Where this conversation works</summary>
     <form id="session-form"><label>Repository folder (optional)<input id="session-repository" placeholder="C:\\path\\to\\project"></label><label>Model<select id="session-model"><option>qwen2.5-coder:7b</option></select></label><label>Runs on<select id="session-executor"><option value="local">local</option></select></label></form>
    </details>
   </div>
   <div class="stack">
    <div class="panel"><h3>Needs you</h3><div id="home-attention" class="list"><p class="empty">Nothing is waiting for you.</p></div></div>
    <div class="panel"><h3>Running now</h3><div id="home-running" class="list"><p class="empty">No missions are running.</p></div></div>
    <div class="panel"><h3>This computer</h3><p class="hint" id="home-owner"></p><div id="home-machine" class="list"><p class="empty">Unlock to see what is available.</p></div></div>
   </div>
  </div>
 </section>

 <section class="view" data-view="command" hidden aria-labelledby="command-heading">
  <div class="section-title"><div><p class="eyebrow">EVERYTHING ATLAS IS DOING</p><h2 id="command-heading">Command center</h2></div><button type="button" class="secondary" id="command-refresh">Refresh</button></div>
  <p class="hint">Missions and their lanes, team missions, Genesis builds, coding tasks and Improve Atlas runs in one place. Pause, resume, cancel or retry a single lane without stopping the others. Updates every few seconds while open.</p>
  <details class="panel" id="command-launch-panel"><summary>Launch agents in parallel</summary>
   <form id="command-launch"><label>Repository folder<input id="launch-repository" required placeholder="C:\\path\\to\\project"></label>
    <label>Model<select id="launch-model"><option>qwen2.5-coder:7b</option></select></label>
    <label>How<select id="launch-mode"><option value="auto">One task: let Atlas decide how many versions to try</option><option value="tasks">Separate tasks, one per line</option><option value="variants">Several versions of one task, to compare</option></select></label>
    <label>What to do<textarea id="launch-text" required maxlength="10000" rows="4" placeholder="Refactor the billing module so invoices can be retried"></textarea></label>
    <label id="launch-count-label" hidden>How many versions<input id="launch-count" type="number" min="2" max="5" value="3"></label>
    <div class="actions"><button>Start</button></div>
    <p class="hint">Each agent works in its own copy of the repository and hands back a patch; nothing changes in your folder until you apply one.</p></form></details>
  <details class="panel" id="command-goal-panel"><summary>Keep at it until a pull request merges</summary>
   <form id="command-goal"><label>What to keep doing<textarea id="goal-text" required maxlength="4000" rows="3" placeholder="Get this pull request merged: fix failing checks and answer review comments"></textarea></label>
    <label>Repository folder<input id="goal-repository" required placeholder="C:\\path\\to\\project"></label>
    <label>GitHub repository<input id="goal-watch" required placeholder="owner/name" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"></label>
    <label>Pull request number<input id="goal-pr" type="number" min="1" required></label>
    <label>Model<input id="goal-model" required value="qwen2.5-coder:7b"></label>
    <div class="actions"><button>Start and keep watching</button></div>
    <p class="hint">Atlas works now, then sleeps. It wakes when checks fail, a review arrives or someone comments, and stops when the pull request merges (at most 10 wakes, 14 days). Events arrive through a GitHub automation's webhook for that repository.</p></form></details>
  <div class="chips" id="command-counts" aria-live="polite"></div>
  <p id="command-notice" class="hint" role="status" aria-live="polite"></p>
  <div id="command-items" class="list"><p class="empty">Unlock this tab to see what Atlas is doing.</p></div>
 </section>

 <section class="view" data-view="automations" hidden aria-labelledby="automations-heading">
  <div class="section-title"><div><p class="eyebrow">RUNS WHILE YOU ARE AWAY</p><h2 id="automations-heading">Automations</h2></div><button type="button" class="secondary" id="automations-refresh">Refresh</button></div>
  <p class="hint">A schedule, a webhook or a button starts the same kind of work you start by hand, with the same approvals and budgets. A run is skipped while the previous one is still going, each automation has a daily limit, and one that fails to start three times in a row pauses itself and tells you why.</p>
  <details class="panel" id="automation-new-panel"><summary>New automation</summary>
   <form id="automation-form"><label>Name<input id="auto-name" required maxlength="120" placeholder="Nightly dependency check"></label>
    <label>Starts<select id="auto-trigger"><option value="schedule">On a schedule</option><option value="github">On a GitHub event</option><option value="file">When files in a folder change</option><option value="webhook">When a webhook is called</option><option value="manual">Only when I press Run now</option></select></label>
    <label id="auto-cron-label">Schedule (minute hour day month weekday, this computer's time)<input id="auto-cron" value="0 9 * * 1-5" placeholder="0 9 * * 1-5"></label>
    <label id="auto-github-label" hidden>GitHub events<select id="auto-github-events" multiple size="4"><option value="push" selected>push</option><option value="pull_request">pull_request</option><option value="issues">issues</option><option value="issue_comment">issue_comment</option><option value="release">release</option><option value="workflow_run">workflow_run</option><option value="check_suite">check_suite</option></select></label>
    <label id="auto-branches-label" hidden>Only these branches (comma-separated, empty for all)<input id="auto-branches" placeholder="main"></label>
    <label id="auto-path-label" hidden>Folder to watch (full path)<input id="auto-path" placeholder="C:\\path\\to\\inbox"></label>
    <label>Does<select id="auto-kind"><option value="mission">Coding tasks in a repository</option><option value="team">A goal for the agent team</option></select></label>
    <label class="auto-mission">Repository folder<input id="auto-repository" placeholder="C:\\path\\to\\project"></label>
    <label class="auto-mission">Model<select id="auto-model"><option>qwen2.5-coder:7b</option></select></label>
    <label>What to do (for coding tasks, one per line)<textarea id="auto-text" required maxlength="4000" rows="3" placeholder="Update dependencies and run the tests"></textarea></label>
    <label>Most runs per day<input id="auto-max" type="number" min="1" max="288" value="24"></label>
    <div class="actions"><button>Create</button></div></form></details>
  <p id="automations-notice" class="hint" role="status" aria-live="polite"></p>
  <div id="automation-secret" class="card" hidden></div>
  <div id="automations-list" class="list"><p class="empty">Unlock this tab to see automations.</p></div>
 </section>

 <section class="view" data-view="build" hidden aria-labelledby="build-heading">
  <div class="section-title"><div><p class="eyebrow">PROJECT GENESIS</p><h2 id="build-heading">Build something</h2></div><button type="button" class="secondary" id="build-refresh">Refresh</button></div>
  <form id="build-form" class="panel"><label for="build-prompt">What should Atlas build?</label><textarea id="build-prompt" rows="3" maxlength="4000" placeholder="Build me a simple CRM for my construction company"></textarea>
   <div class="chips" id="build-examples"><button type="button" class="chip" data-example="Build a website for my roofing company">Roofing website</button><button type="button" class="chip" data-example="Build me a booking website for my landscaping company">Booking site</button><button type="button" class="chip" data-example="Build a simple customer lead tracker with name, email, phone, status, notes and search">Lead tracker</button><button type="button" class="chip" data-example="Build a REST API for managing inventory items">Inventory API</button></div>
   <div class="actions"><button id="build-start">Build it</button></div><p id="build-notice" class="hint" role="status" aria-live="polite"></p>
   <p class="hint">Atlas writes the requirements with sensible assumptions, plans the work, builds it on this computer, tests it, runs it, checks it in a browser and fixes problems. It asks only when an answer changes cost, data rules or who gets contacted, and it asks before publishing anything.</p></form>
  <div id="build-detail" hidden></div>
  <section aria-labelledby="build-projects-heading"><h3 id="build-projects-heading">Projects</h3><div id="build-projects" class="list"><p class="empty">Unlock this tab to see projects.</p></div></section>
 </section>
 <section class="view" data-view="missions" hidden aria-labelledby="missions-view-heading">
  <div class="hero"><h2 id="missions-view-heading">Missions</h2><p class="lede">Describe an outcome. The Product Executive plans it into steps, each step goes to the agent best placed to do it, and every step is checked against its own completion test before the mission counts as done.</p></div>
  <form id="goal-form" class="panel"><label for="goal-text">Goal</label><textarea id="goal-text" maxlength="4000" required placeholder="For example: research three competitors' pricing pages and summarize how ours compares"></textarea><div class="actions"><button>Plan and start</button></div><p id="goal-notice" class="hint" role="status" aria-live="polite"></p></form>
  <div class="split">
   <div><div class="section-title"><h3>All missions</h3><button type="button" class="ghost" id="team-refresh">Refresh</button></div><div id="team-missions" class="list" aria-live="polite"><p class="empty">Unlock to load missions.</p></div></div>
   <div id="mission-detail" class="panel detail" aria-live="polite"><p class="empty">Choose a mission to see its plan, who did what, the tools they used and how each step was checked.</p></div>
  </div>
  <details class="more panel"><summary>Explicit lanes for coding work (advanced)</summary>
  <section aria-labelledby="missions-heading"><div class="section-title"><div><p class="eyebrow">PARALLEL CODER LANES</p><h2 id="missions-heading">Mission Control</h2></div><button type="button" class="secondary" id="mission-refresh">Refresh</button></div>
  <p class="hint">Define the lanes yourself. Atlas starts a lane only after its dependencies finish and keeps every lane inside the mission budget.</p>
  <form id="mission-form"><label>Mission objective<textarea id="mission-objective" required maxlength="10000" placeholder="Describe the result these lanes should deliver"></textarea></label><label>Repository folder<input id="mission-repository" required placeholder="C:\\path\\to\\project"></label><label>Model<select id="mission-model"><option>qwen2.5-coder:7b</option></select></label><label>Lanes (JSON)<textarea id="mission-lanes" required spellcheck="false" placeholder='[{"id":"research","objective":"Inspect current behavior","dependencies":[]},{"id":"build","objective":"Implement the change","dependencies":["research"]}]'></textarea></label><p class="hint">Every lane needs a dependencies array. Use [] for a lane that can start immediately.</p><label>Maximum lanes at once<input id="mission-concurrency" type="number" min="1" step="1" value="3"></label><button>Create mission</button></form><p id="mission-notice" class="hint" role="status" aria-live="polite"></p><div id="missions" class="list" aria-live="polite"><p class="empty">Unlock this tab to load missions.</p></div></section>
  </details>
 </section>

 <section class="view" data-view="improve" hidden aria-labelledby="improve-heading">
  <div class="section-title"><div><p class="eyebrow">ATLAS BUILDS ATLAS</p><h2 id="improve-heading">Improve Atlas</h2></div><button type="button" class="secondary" id="improve-refresh">Refresh</button></div>
  <p class="hint">Atlas picks one small improvement at a time (a failing check first, then a TODO), makes it in an isolated worktree with the local model, re-runs the checks, applies the self-modification policy and has a separate reviewer approve it. Nothing reaches your checkout until you approve it here.</p>
  <form id="improve-form" class="panel"><label>Iterations<input id="improve-iterations" type="number" min="1" max="20" step="1" value="1"></label><button id="improve-start">Improve yourself</button><p id="improve-notice" class="hint" role="status" aria-live="polite"></p></form>
  <div class="panel"><div class="task-top"><h3>Progress</h3><span id="improve-state"></span></div><pre id="improve-log" class="log" aria-live="polite">Unlock this tab to load progress.</pre></div>
  <section aria-labelledby="improve-pending-heading"><h3 id="improve-pending-heading">Waiting for your approval</h3><div id="improve-pending" class="list"><p class="empty">Nothing waiting.</p></div></section>
  <section aria-labelledby="improve-recent-heading"><h3 id="improve-recent-heading">Recent attempts</h3><div id="improve-recent" class="list"><p class="empty">No attempts yet.</p></div></section>
 </section>
 <section class="view" data-view="models" hidden aria-labelledby="models-heading">
  <div class="section-title"><div><p class="eyebrow">RUNS ON THIS COMPUTER</p><h2 id="models-heading">Models</h2></div><button type="button" class="secondary" id="models-refresh">Refresh</button></div>
  <p class="hint">Atlas runs open models on this machine: pick one, install it, and Atlas starts the local model server, loads the model with a context length that fits your memory, and routes easy work to fast models and hard work to strong ones. Sizes are estimates for 4-bit quantized models.</p>
  <div class="panel"><div class="task-top"><h3>This machine</h3><span id="models-runtime-state"></span></div><div id="models-machine"><p class="empty">Unlock this tab to load models.</p></div><div class="actions"><button type="button" id="models-start">Start model server</button><button type="button" class="secondary" id="models-stop">Stop</button></div><p id="models-notice" class="hint" role="status" aria-live="polite"></p></div>
  <div class="panel"><div class="task-top"><h3>Recommended for this machine</h3><button type="button" id="models-apply">Use this plan</button></div><div id="models-plan"></div></div>
  <section aria-labelledby="models-catalog-heading"><h3 id="models-catalog-heading">Catalog</h3><div id="models-catalog" class="list"></div></section>
 </section>
 <section class="view" data-view="families" hidden aria-labelledby="families-heading">
  <div class="hero"><h2 id="families-heading">Agent families</h2><p class="lede">Atlas works as an organization. Executives commission work, specialists do it, and peer organizations help when asked. Authority only narrows as work is handed down, and every hand-off is recorded.</p></div>
  <div class="actions"><a class="button secondary" href="/innovation">Opportunity pipeline</a><a class="button ghost" href="/platform">Task ledger</a></div>
  <div id="org-tree" class="panel tree"><p class="empty">Unlock to load the organization.</p></div>
 </section>

 <section class="view" data-view="computer" hidden aria-labelledby="computer-heading">
  <div class="hero"><h2 id="computer-heading">Computer</h2><p class="lede">What agents may do on this machine. Each capability is set to allow, ask or deny. Ask means Atlas stops and waits for you, for that exact action, every time. On a machine without a supported browser or desktop, those tools refuse with a reason instead of pretending.</p></div>
  <section class="panel" id="operator-panel" aria-labelledby="operator-heading"><div class="task-top"><h3 id="operator-heading">Atlas on your computer</h3><span id="operator-state"></span></div>
   <p id="operator-line" class="hint">Atlas is not operating the computer right now.</p><div class="actions" id="operator-actions"></div><div id="operator-uncertain"></div>
   <details class="more"><summary>Recent steps</summary><div id="operator-milestones" class="list"><p class="empty">Nothing yet.</p></div></details>
   <p id="operator-notice" class="hint" role="status" aria-live="polite"></p>
   <p class="hint">Pause stops Atlas before its next step. Take over when you want to use the computer yourself: Atlas will not touch it, and will look at the page again before it acts once you hand control back. Steps show where Atlas is working and how risky each was, never what it typed.</p></section>
  <div id="computer-tools" class="list"><p class="empty">Unlock to load tools.</p></div>
 </section>

 <section class="view" data-view="projects" hidden aria-labelledby="projects-heading">
  <div class="hero"><h2 id="projects-heading">Projects</h2><p class="lede">Run a bounded coding change against a folder on this computer. It runs in an isolated copy, so your working tree is never touched until you take the result.</p></div>
  <form id="task-form" class="panel"><label>Repository folder<input id="repository" required placeholder="C:\\path\\to\\project"></label><label>What should change<textarea id="objective" required maxlength="10000" placeholder="Describe one bounded change"></textarea></label><label>Model<select id="model"><option>qwen2.5-coder:7b</option></select></label><button>Start isolated run</button></form>
  <div class="section-title"><h3>Runs</h3><button class="ghost" id="refresh">Refresh</button></div><div id="tasks" class="list"><p class="empty">Unlock this tab to load runs.</p></div>
 </section>

 <section class="view" data-view="knowledge" hidden aria-labelledby="knowledge-heading">
  <div class="hero"><h2 id="knowledge-heading">Knowledge</h2><p class="lede">What Atlas has learned from verified work. Every entry says where it came from. Agents only see their own family's knowledge; you see everything shared with you, and deleting an entry erases every version of it.</p></div>
  <form id="knowledge-form" class="panel inline"><label class="sr" for="knowledge-q">Search knowledge</label><input id="knowledge-q" type="search" placeholder="Search what Atlas knows"><button>Search</button></form>
  <div id="knowledge-list" class="list"><p class="empty">Unlock to search knowledge.</p></div>
 </section>

 <section class="view" data-view="connections" hidden aria-labelledby="connections-heading">
  <div class="hero"><h2 id="connections-heading">Connections</h2><p class="lede">Models, tool servers and phones connected to this Atlas.</p></div>
  <div class="panel"><h3>Models</h3><div id="models-health" class="list"><p class="empty">Unlock to check models.</p></div></div>
  <div class="panel"><h3>Tool servers (MCP)</h3><p class="hint">Configured with ATLAS_MCP_SERVERS. A new server's tools are denied until you allow its capability here. Tool descriptions that look like instructions are blocked, and every result is treated as untrusted data.</p><div id="mcp-list" class="list"><p class="empty">No tool servers configured.</p></div></div>
  <div class="panel"><div class="section-title"><h3>Phones</h3><button class="secondary" id="pair">Pair a phone</button></div><p id="pair-code" role="status"></p><div id="devices" class="list"><p class="empty">No paired phones.</p></div></div>
 </section>

 <section class="view" data-view="approvals" hidden aria-labelledby="approvals-heading">
  <div class="hero"><h2 id="approvals-heading">Approvals</h2><p class="lede">Actions waiting for your decision. An approval covers only the exact action shown and can be used once.</p></div>
  <div class="actions"><button class="secondary" id="notify">Notify me in this browser</button></div>
  <div id="approvals" class="list"><p class="empty">Nothing is waiting for you.</p></div>
 </section>

 <section class="view" data-view="settings" hidden aria-labelledby="settings-heading">
  <div class="hero"><h2 id="settings-heading">Settings</h2></div>
  <div class="panel"><h3>Access</h3><p class="hint">This tab holds your access token until you close it.</p><button type="button" class="secondary" id="lock">Lock this tab</button></div>
  <div class="panel" id="remote-panel"><h3>Reach Atlas from your phone</h3><p class="hint">Atlas only listens on this computer. To use it from your phone, put it behind your own private network or HTTPS proxy; no Atlas server is involved. Phones sign in by pairing and get their own token you can revoke.</p><div id="remote-status"><p class="empty">Unlock this tab to check remote access.</p></div>
   <div class="actions"><button type="button" id="remote-tailscale">Use my Tailscale network</button><button type="button" class="secondary" id="remote-off">Turn off remote access</button></div>
   <form id="remote-proxy-form"><label>Or my own HTTPS address (Caddy, nginx, VPN)<input id="remote-proxy-url" type="url" placeholder="https://atlas.example.com"></label><button class="secondary">Use this address</button></form>
   <details><summary>Proxy configuration</summary><pre id="remote-guides" class="log"></pre></details>
   <label class="check"><input type="checkbox" id="remote-owner"> Also accept the owner token remotely (not recommended; paired devices are safer)</label>
   <div class="actions"><button type="button" id="remote-pair">Pair a device</button></div><p id="remote-pair-code" class="hint" role="status" aria-live="polite"></p><p id="remote-notice" class="hint" role="status" aria-live="polite"></p></div>
  <div class="panel"><h3>Appearance</h3><label>Theme<select id="theme-select"><option value="system">Match this device</option><option value="dark">Dark</option><option value="light">Light</option></select></label></div>
  <div class="panel"><h3>Policies</h3><p class="hint">Every capability Atlas knows about. Anything not listed here is denied.</p><div id="policies"></div></div>
  <div class="panel"><h3>Encrypted backup</h3><label>Backup passphrase<input id="passphrase" type="password" autocomplete="new-password" minlength="12"></label><div class="actions"><button id="export">Export</button><button class="secondary" id="import">Import pasted backup</button></div><label>Encrypted backup<textarea id="backup" placeholder="Encrypted Atlas backup JSON"></textarea></label></div>
  <div class="panel"><h3>Audit log</h3><div id="audit" class="list"><p class="empty">No audit events.</p></div></div>
 </section>
 </main>
</div>
<nav class="tabbar" aria-label="Quick sections">
 <a href="#/home" data-nav="home"><span aria-hidden="true">⌂</span>Home</a>
 <a href="#/missions" data-nav="missions"><span aria-hidden="true">◎</span>Missions</a>
 <a href="#/approvals" data-nav="approvals"><span aria-hidden="true">✓</span>Approvals</a>
 <a href="#/computer" data-nav="computer"><span aria-hidden="true">▣</span>Computer</a>
 <button type="button" id="tab-more"><span aria-hidden="true">☰</span>More</button>
</nav>
</div>
<script type="module" src="/app.js"></script></body></html>`;

export const LOCAL_UI_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#d8ff8f"/><path d="M32 13 49 51H41l-3.6-8.4H26.6L23 51h-8L32 13Zm0 14.5-3 8.6h6l-3-8.6Z" fill="#14200f"/></svg>`;

export const LOCAL_UI_CSS = `:root{--bg:#0c110e;--bg-2:#111814;--surface:#151d18;--surface-2:#1b251f;--line:#2b3a31;--line-2:#3a4c41;--text:#eef4ef;--muted:#9db0a2;--faint:#76897b;--accent:#d8ff8f;--accent-ink:#14200f;--accent-soft:#2c3d1c;--good:#9be39b;--warn:#ffd27a;--bad:#ffab9f;--focus:#b9e86a;--radius:14px;--shadow:0 18px 60px #0005;color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
:root[data-theme=light]{--bg:#f5f7f2;--bg-2:#eef1ea;--surface:#ffffff;--surface-2:#f3f6ef;--line:#dfe5da;--line-2:#cbd4c5;--text:#17211b;--muted:#56665b;--faint:#7a887e;--accent:#2f5d12;--accent-ink:#ffffff;--accent-soft:#e7f2d8;--good:#2f7a36;--warn:#8a5a00;--bad:#b3261e;--focus:#2f5d12;--shadow:0 10px 30px #1b2a1e14;color-scheme:light}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#f5f7f2;--bg-2:#eef1ea;--surface:#ffffff;--surface-2:#f3f6ef;--line:#dfe5da;--line-2:#cbd4c5;--text:#17211b;--muted:#56665b;--faint:#7a887e;--accent:#2f5d12;--accent-ink:#ffffff;--accent-soft:#e7f2d8;--good:#2f7a36;--warn:#8a5a00;--bad:#b3261e;--focus:#2f5d12;--shadow:0 10px 30px #1b2a1e14;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;-webkit-text-size-adjust:100%}
a{color:var(--accent)}:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-9999px}.skip:focus{left:12px;top:12px;z-index:50;background:var(--surface);padding:8px 12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.rail{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:18px;padding:20px 14px;border-right:1px solid var(--line);background:var(--bg-2)}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);padding:4px 8px}.brand small{display:block;color:var(--faint);font-size:.72rem}
.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:800}
.nav{display:grid;gap:2px}.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;color:var(--muted);text-decoration:none;font-size:.93rem}
.nav a:hover{background:var(--surface-2);color:var(--text)}.nav a[aria-current=page]{background:var(--accent-soft);color:var(--text);font-weight:650}
.ico{width:20px;text-align:center;opacity:.85}.badge{margin-left:auto;background:var(--accent);color:var(--accent-ink);border-radius:999px;font-size:.72rem;font-weight:750;padding:1px 8px}
.rail-foot{margin-top:auto;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:.8rem;padding:0 8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}.dot.ok{background:var(--good)}.dot.bad{background:var(--bad)}
.main{min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:14px 28px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.topbar h1{font-size:1.05rem;margin:0;flex:1}.icon-btn{background:transparent;border:1px solid var(--line);color:var(--text);width:38px;height:38px;padding:0;border-radius:10px;font-size:1rem}
#menu{display:none}
main{padding:24px 28px 96px;max-width:1180px;width:100%;outline:none}
.view[hidden],[hidden]{display:none!important}
.hero{margin:6px 0 20px}.hero h2{font-size:clamp(1.7rem,4vw,2.6rem);letter-spacing:-.03em;line-height:1.05;margin:4px 0 10px}.lede{color:var(--muted);max-width:68ch;margin:0}
.eyebrow{font-size:.72rem;letter-spacing:.14em;color:var(--accent);font-weight:700;margin:0}
h3{font-size:1rem;margin:0 0 12px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:0 0 16px;box-shadow:var(--shadow)}
.grid-home>*,.split>*{min-width:0}.section-title select{width:auto;flex:1;min-width:0}.grid-home{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr);gap:16px;align-items:start}.stack{display:grid;gap:0}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:16px;align-items:start}
.detail{position:sticky;top:78px;max-height:calc(100vh - 100px);overflow:auto}
label{display:grid;gap:6px;margin:0 0 14px;color:var(--muted);font-size:.88rem}
input,textarea,select,button,.button{font:inherit;border-radius:10px}
input,textarea,select{width:100%;border:1px solid var(--line-2);background:var(--bg);color:var(--text);padding:11px 12px}
textarea{min-height:96px;resize:vertical}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;background:var(--accent);color:var(--accent-ink);font-weight:700;padding:10px 16px;cursor:pointer;text-decoration:none;min-height:40px}
button:disabled{opacity:.5;cursor:not-allowed}
.secondary{background:var(--surface-2);color:var(--text);border-color:var(--line-2)}.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
.danger{background:transparent;color:var(--bad);border-color:var(--bad)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.section-title h3,.section-title h2{margin:0}.inline{display:flex;gap:8px}.inline input{flex:1}
.list{display:grid;gap:10px}.empty{color:var(--faint);margin:0}.hint{color:var(--muted);font-size:.85rem;margin:8px 0}
.task,.card{border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:14px;margin:0}
.card.clickable{cursor:pointer;text-align:left;width:100%;color:inherit;font-weight:inherit;display:block;background:var(--surface)}
.card.clickable:hover,.card.selected{border-color:var(--accent)}
.task-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.task h3,.card h4{font-size:.97rem;margin:0;overflow-wrap:anywhere;font-weight:650}
.task p,.card p{color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0}
.meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--faint);font-size:.78rem;margin-top:8px}
time{color:var(--faint);font-size:.78rem}
.status,.pill{display:inline-block;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--surface-2);color:var(--muted);white-space:nowrap}
.status.running,.status.queued,.status.pending,.status.verifying,.status.planning{color:var(--warn)}
.status.completed,.status.succeeded,.status.verified,.status.connected,.status.allow{color:var(--good)}
.status.failed,.status.interrupted,.status.denied,.status.cancelled,.status.rejected,.status.deny{color:var(--bad)}
.status.ask{color:var(--warn)}
progress{width:100%;height:6px;accent-color:var(--accent);margin-top:10px}
.chip{display:inline-block;font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted);margin:2px 4px 0 0}
.steps{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:10px}.steps li{border-left:3px solid var(--line-2);padding:4px 0 4px 12px}
.steps li.completed{border-color:var(--good)}.steps li.failed{border-color:var(--bad)}.steps li.running{border-color:var(--warn)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:.85rem}.kv dt{color:var(--faint)}.kv dd{margin:0;overflow-wrap:anywhere}
.table{width:100%;border-collapse:collapse;font-size:.84rem}.table th,.table td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}.table th{color:var(--faint);font-weight:600}
.tree ul{list-style:none;margin:0;padding-left:18px;border-left:1px dashed var(--line-2)}.tree>ul{padding-left:0;border:0}.tree li{margin:10px 0}
.node{display:inline-block;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--surface-2)}.node small{color:var(--faint);display:block}
.policy{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.policy select{width:120px}
.group{margin-bottom:18px}.group h3{display:flex;justify-content:space-between;align-items:center}
.tool{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:10px 0;border-top:1px solid var(--line)}.tool code{font-size:.82rem}.tool p{grid-column:1/-1;margin:0;color:var(--muted);font-size:.85rem}
.transcript{display:grid;gap:10px;max-height:52vh;min-height:180px;overflow-y:auto;border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--bg);margin-bottom:12px}
.line{display:grid;gap:2px}.line .who{font-size:.68rem;letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}.line p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.line.progress p{color:var(--muted);font-size:.86rem}.line.failed p,.line.cancelled p{color:var(--bad)}
.composer-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}.composer-bar .actions{margin:0}
.attach{display:inline-flex;align-items:center;gap:8px;margin:0;font-size:.85rem}.attach input{width:auto;padding:6px;border:0;background:none}
details.more{margin-top:10px}details.more>summary{cursor:pointer;color:var(--muted);font-size:.88rem;padding:6px 0}
.evidence summary{cursor:pointer;color:var(--muted)}.lane{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.lane.recommended{border-top-color:var(--accent)}.trace summary{cursor:pointer;color:var(--muted)}.trace-steps{margin:6px 0 0;padding-left:20px;font-size:.9em}.trace-steps li{margin:2px 0}
.toast{margin:0;padding:0 28px}.toast:not(:empty){padding:10px 28px;background:var(--accent-soft);color:var(--text);font-size:.9rem}
.unlock{margin:24px 28px 0;max-width:560px}
.error{border:1px solid var(--bad);color:var(--bad);border-radius:12px;padding:12px 14px}.error p{color:var(--text);margin:6px 0 0}
.tabbar{display:none}.scrim{display:none}
@media (max-width:980px){.grid-home,.split{grid-template-columns:1fr}.detail{position:static;max-height:none}}
@media (max-width:760px){
.app{grid-template-columns:1fr}
.rail{position:fixed;inset:0 auto 0 0;width:min(300px,84vw);z-index:30;transform:translateX(-105%);transition:transform .2s ease;padding-top:max(20px,env(safe-area-inset-top))}
body.nav-open .rail{transform:none}body.nav-open .scrim{display:block;position:fixed;inset:0;background:#0008;z-index:20}
#menu{display:inline-grid;place-items:center}
.topbar{padding:10px 16px;padding-top:max(10px,env(safe-area-inset-top))}
main{padding:16px 16px calc(96px + env(safe-area-inset-bottom))}.toast:not(:empty){padding:10px 16px}.unlock{margin:16px}
.panel{padding:15px}.hero h2{font-size:1.7rem}
.tabbar{display:grid;grid-template-columns:repeat(5,1fr);position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--bg-2);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
.tabbar a,.tabbar button{display:grid;justify-items:center;gap:2px;padding:8px 2px;font-size:.7rem;color:var(--muted);text-decoration:none;background:none;border:0;border-radius:0;font-weight:500;min-height:54px}
.tabbar span{font-size:1.1rem}.tabbar a[aria-current=page]{color:var(--accent)}
input,textarea,select{font-size:16px}
.transcript{max-height:46vh}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}.lanes{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:6px}.lane{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg-2)}.lane .actions{margin-top:6px}.lane .actions:empty{display:none}.command-bucket{margin:18px 0 6px;font-size:.85rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.steps-list{list-style:none;padding:0;margin:12px 0}.steps-list .step{padding:4px 0;color:var(--muted)}.steps-list .step.done{color:var(--text)}.steps-list .step.running{color:var(--accent);font-weight:600}.steps-list .step.failed{color:var(--danger,#b42318)}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}button.chip{cursor:pointer;background:none}.row{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.row .grow{flex:1 1 240px}.pair-form{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}.check{display:flex;gap:8px;align-items:center;margin:10px 0}.check input{width:auto}.log{max-height:360px;overflow:auto;margin:8px 0 0;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:var(--muted)}
`;

export const LOCAL_UI_JS = `/* Signed in by open-atlas: the owner token arrives in the URL fragment (never sent to a server) and is kept for this tab only. */{const m=/[#&]signin=([A-Za-z0-9_-]{32,128})/.exec(location.hash);if(m){sessionStorage.setItem('atlas-token',m[1]);history.replaceState(null,'',location.pathname+'#/home')}}/* A paired device keeps its own revocable token on this device. */try{const d=localStorage.getItem('atlas-device-token');if(d&&!sessionStorage.getItem('atlas-token'))sessionStorage.setItem('atlas-token',d)}catch{}const pairFromLink=(/[#&]pair=([0-9]{6})/.exec(location.hash)||[])[1]||'';if(pairFromLink)history.replaceState(null,'',location.pathname+'#/home');const q=s=>document.querySelector(s),tokenInput=q('#token'),tasks=q('#tasks'),notice=q('#notice');let knownApprovals=new Set;tokenInput.value=sessionStorage.getItem('atlas-token')||'';const headers=()=>({authorization:'Bearer '+sessionStorage.getItem('atlas-token')}),api=(url,options={})=>fetch(url,{...options,headers:{...headers(),...(options.headers||{})}});function esc(v){const d=document.createElement('div');d.textContent=v??'';return d.innerHTML}async function load(){const [tr,ar,pr,lr,dr]=await Promise.all(['/v1/tasks','/v1/approvals','/v1/policies','/v1/audit','/v1/devices'].map(u=>api(u)));if(tr.status===401){tasks.innerHTML='<p class="empty">Unlock this tab to load tasks.</p>';return}const list=(await tr.json()).tasks;tasks.innerHTML=list.length?list.map(t=>'<article class="task"><div class="task-top"><h3>'+esc(t.objective)+'</h3><span class="status '+t.status+'">'+t.status+'</span></div><p>'+esc(t.repository)+' · '+esc(t.model)+'</p>'+(t.message?'<p>'+esc(t.message)+'</p>':'')+'<time>'+new Date(t.createdAt).toLocaleString()+'</time></article>').join(''):'<p class="empty">No local tasks yet.</p>';const approvals=(await ar.json()).approvals,pending=approvals.filter(a=>a.status==='pending');if('Notification'in window&&Notification.permission==='granted')pending.filter(a=>!knownApprovals.has(a.id)).forEach(a=>new Notification('Atlas approval required',{body:a.capability+': '+a.summary,tag:a.id}));knownApprovals=new Set(pending.map(a=>a.id));q('#approvals').innerHTML=pending.map(a=>'<article class="task"><h3>'+esc(a.capability)+'</h3><p>'+esc(a.summary)+'</p>'+(a.riskLevel!=null?'<p class="hint">Risk level '+a.riskLevel+' of 5'+(a.riskLevel>=4?': you will be asked to confirm a second time':'')+'</p>':'')+'<div class="actions"><button data-decision="approved" data-level="'+(a.riskLevel??'')+'" data-id="'+a.id+'">Approve</button><button class="secondary" data-decision="denied" data-id="'+a.id+'">Deny</button></div></article>').join('')||'<p class="empty">No pending approvals.</p>';q('#approvals').querySelectorAll('button').forEach(b=>b.onclick=()=>decide(b.dataset.id,b.dataset.decision,Number(b.dataset.level||0)));const policies=(await pr.json()).policies;q('#policies').innerHTML=policies.map(p=>'<div class="policy"><span>'+esc(p.capability)+'</span><select data-capability="'+esc(p.capability)+'"><option'+(p.decision==='allow'?' selected':'')+'>allow</option><option'+(p.decision==='ask'?' selected':'')+'>ask</option><option'+(p.decision==='deny'?' selected':'')+'>deny</option></select></div>').join('');q('#policies').querySelectorAll('select').forEach(s=>s.onchange=()=>api('/v1/policies',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({capability:s.dataset.capability,decision:s.value})}).then(load));const events=(await lr.json()).events;q('#audit').innerHTML=events.slice(0,50).map(e=>'<article class="task"><div class="task-top"><h3>'+esc(e.category)+'</h3><time>'+new Date(e.createdAt).toLocaleString()+'</time></div><p>'+esc(e.summary)+'</p></article>').join('')||'<p class="empty">No audit events.</p>';const devices=(await dr.json()).devices;q('#devices').innerHTML=devices.filter(d=>!d.revokedAt).map(d=>'<article class="task"><div class="task-top"><h3>'+esc(d.name)+'</h3><button class="secondary" data-device="'+d.id+'">Revoke</button></div><time>'+new Date(d.createdAt).toLocaleString()+'</time></article>').join('')||'<p class="empty">No paired devices.</p>';q('#devices').querySelectorAll('button').forEach(b=>b.onclick=()=>api('/v1/devices/'+b.dataset.device,{method:'DELETE'}).then(load))}async function decide(id,decision,level=0){const strong=decision==='approved'&&level>=4;if(strong&&!confirm('This action can spend money, affect production, destroy data or handle a credential. Approve it?'))return;await api('/v1/approvals/'+id+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(strong?{decision,confirm:true}:{decision})});load()}async function models(){const r=await api('/v1/models');if(!r.ok)return;const v=await r.json();if(v.models.length)q('#model').innerHTML=v.models.map(m=>'<option>'+esc(m)+'</option>').join('')}q('#save-token').onclick=()=>{sessionStorage.setItem('atlas-token',tokenInput.value);load();models();loadSessions();if(sessionId)selectSession(sessionId)};q('#refresh').onclick=load;q('#notify').onclick=async()=>{if(!('Notification'in window))return notice.textContent='Notifications are unavailable in this browser.';const result=await Notification.requestPermission();notice.textContent=result==='granted'?'Approval notifications enabled.':'Notification permission was not granted.'};q('#task-form').onsubmit=async e=>{e.preventDefault();notice.textContent='Queueing…';const r=await api('/v1/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repository:q('#repository').value,objective:q('#objective').value,model:q('#model').value})});const data=await r.json();notice.textContent=r.ok?(data.approval?'Waiting for approval.':'Task queued in an isolated worktree.'):data.message;load()};q('#pair').onclick=async()=>{const r=await api('/v1/pair',{method:'POST'}),v=await r.json();q('#pair-code').textContent=r.ok?'Pairing code '+v.code+' expires '+new Date(v.expiresAt).toLocaleTimeString():v.message};q('#export').onclick=async()=>{const r=await api('/v1/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:q('#passphrase').value})}),v=await r.json();q('#backup').value=r.ok?JSON.stringify(v.backup):v.message};q('#import').onclick=async()=>{let backup;try{backup=JSON.parse(q('#backup').value)}catch{return notice.textContent='Backup JSON is invalid.'}const r=await api('/v1/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:q('#passphrase').value,backup})});notice.textContent=r.ok?'Backup imported.':'Import failed.';load()};fetch('/health').then(r=>r.json()).then(v=>q('#health').textContent=v.status==='ok'?'Atlas is running':'Atlas is not responding').catch(()=>q('#health').textContent='Unavailable');if(tokenInput.value){load();models()}setInterval(()=>{if(sessionStorage.getItem('atlas-token'))load()},5000);
let sessionId=sessionStorage.getItem('atlas-session')||'',cursor=0,stream=null;
const transcript=q('#transcript'),runStatus=q('#run-status');
const WHO={assistant_message:'Atlas',status:'Progress',tool_proposal:'Proposed tool',tool_execution:'Tool',validation_result:'Validation',approval_request:'Approval needed',artifact:'Artifact',error:'Error',completion:'Result'};
function line(event){
 const d=event.data||{};
 let text=d.text||d.summary||'';
 if(event.kind==='tool_proposal')text=d.tool+' ('+d.capability+', '+d.risk+') — '+(d.summary||'');
 if(event.kind==='tool_execution')text=d.tool+' '+d.outcome+' in '+d.durationMs+'ms'+(d.summary?' — '+d.summary:'');
 if(event.kind==='validation_result')text=d.profileId+': '+d.outcome+(d.summary?' — '+d.summary:'');
 if(event.kind==='artifact')text=d.name+' → '+d.path;
 if(event.kind==='completion')text=d.status+(d.summary?' — '+d.summary:'');
 const progress=event.kind!=='assistant_message'&&event.kind!=='completion';
 const tone=event.kind==='error'?' failed':(event.kind==='completion'&&d.status!=='completed'?' cancelled':'');
 const el=document.createElement('article');
 el.className='line'+(progress?' progress':'')+tone;
 el.innerHTML='<span class="who">'+esc(WHO[event.kind]||event.kind)+'</span><p>'+esc(text)+'</p>';
 transcript.append(el);transcript.scrollTop=transcript.scrollHeight;
 if(event.kind==='completion')runStatus.textContent='Session '+d.status+'.';
}
/* Streams with fetch rather than EventSource: EventSource cannot carry the
   local bearer token, and putting that token in a query string would write it
   into browser history and any proxy log. */
async function openStream(){
 if(!sessionId)return;
 const controller=new AbortController();stream?.abort();stream=controller;
 const response=await api('/v1/sessions/'+sessionId+'/events?after='+cursor,{signal:controller.signal});
 if(!response.ok||!response.body)return;
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 try{
  for(;;){
   const chunk=await reader.read();if(chunk.done)break;
   buffer+=decoder.decode(chunk.value,{stream:true});
   let boundary=buffer.indexOf('\\n\\n');
   while(boundary!==-1){
    const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
    const data=frame.split('\\n').find(l=>l.startsWith('data: '));
    if(data){const event=JSON.parse(data.slice(6));cursor=event.sequence;line(event)}
    boundary=buffer.indexOf('\\n\\n');
   }
  }
 }catch{/* The tab was closed or the daemon restarted; reopening replays from the cursor. */}
}
async function selectSession(id,{replay=true}={}){
 sessionId=id;sessionStorage.setItem('atlas-session',id);cursor=0;
 transcript.innerHTML='';runStatus.textContent='';
 if(replay)await openStream();
 const detail=await api('/v1/sessions/'+id);
 if(detail.ok){const v=await detail.json();q('#session-repository').value=v.session.repository||'';runStatus.textContent='Session '+v.session.status+'.'}
}
async function loadSessions(){
 const response=await api('/v1/sessions');if(!response.ok)return;
 const list=(await response.json()).sessions;
 q('#session-picker').innerHTML='<option value="">New conversation…</option>'+list.map(s=>'<option value="'+s.id+'"'+(s.id===sessionId?' selected':'')+'>'+esc(s.title)+' · '+esc(s.status)+'</option>').join('');
 const executors=await api('/v1/executors');
 if(executors.ok)q('#session-executor').innerHTML=(await executors.json()).executors.map(e=>'<option value="'+esc(e)+'">'+esc(e)+'</option>').join('');
}
q('#session-picker').onchange=e=>{if(e.target.value)selectSession(e.target.value);else{sessionId='';sessionStorage.removeItem('atlas-session');transcript.innerHTML='';runStatus.textContent=''}};
q('#turn-form').onsubmit=async e=>{
 e.preventDefault();
 const text=q('#turn-text').value.trim();if(!text)return;
 if(!sessionId){
  const created=await api('/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:text.slice(0,80),repository:q('#session-repository').value||null,model:q('#session-model').value,executor:q('#session-executor').value})});
  if(!created.ok){runStatus.textContent=(await created.json()).message;return}
  await selectSession((await created.json()).session.id,{replay:false});openStream();
 }
 q('#turn-text').value='';
 const attachments=await collectAttachments();
 const sent=await api('/v1/sessions/'+sessionId+'/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,attachments})});
 if(!sent.ok)runStatus.textContent=(await sent.json()).message;
 loadSessions();
};
async function control(action){
 if(!sessionId)return;
 const response=await api('/v1/sessions/'+sessionId+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
 const body=await response.json();
 runStatus.textContent=response.ok?'Session '+body.session.status+'.':body.message;
 loadSessions();
}
q('#pause').onclick=()=>control('pause');q('#resume').onclick=()=>control('resume');q('#stop').onclick=()=>control('cancel');q('#retry').onclick=()=>control('retry');
/* Reopening the tab resumes the transcript from where it stopped. */
if(sessionStorage.getItem('atlas-token')){loadSessions();if(sessionId)selectSession(sessionId)}
/* Attachments are read in the browser and sent inline: a file the operator
   picks never becomes a temporary file on disk for Atlas to forget about. */
async function collectAttachments(){
 const input=q('#attachments'),files=[...(input.files||[])];
 const out=[];
 for(const file of files.slice(0,10)){
  if(file.size>8*1024*1024){runStatus.textContent=file.name+' is too large to attach.';continue}
  const kind=file.type.startsWith('image/')?'image':(file.type==='application/pdf'?'pdf':'text');
  if(kind==='text'){out.push({kind,name:file.name,text:await file.text()})}
  else{runStatus.textContent=file.name+' must be attached by path; inline binary attachments are not accepted yet.'}
 }
 input.value='';
 return out;
}
q('#regenerate').onclick=()=>control('regenerate');
q('#edit-last').onclick=async()=>{
 if(!sessionId)return;
 const detail=await api('/v1/sessions/'+sessionId);if(!detail.ok)return;
 const turns=(await detail.json()).turns.filter(t=>t.role==='user');
 const last=turns[turns.length-1];if(!last)return runStatus.textContent='Nothing to edit yet.';
 const text=prompt('Edit your message and resend. Everything after it will be removed.',last.text);
 if(text===null||!text.trim())return;
 const response=await api('/v1/sessions/'+sessionId+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'edit',turnId:last.id,text:text.trim()})});
 const body=await response.json();
 runStatus.textContent=response.ok?'Resent.':body.message;
 if(response.ok)selectSession(sessionId);
};
/* Dictation records locally and posts the audio to whichever transcription
   endpoint this machine is configured for -- loopback by default. */
let recorder=null;
q('#dictate').onclick=async()=>{
 if(recorder){recorder.stop();return}
 if(!navigator.mediaDevices?.getUserMedia)return runStatus.textContent='This browser cannot capture audio.';
 let media;
 try{media=await navigator.mediaDevices.getUserMedia({audio:true})}catch{return runStatus.textContent='Microphone permission was not granted.'}
 const chunks=[];
 recorder=new MediaRecorder(media);
 recorder.ondataavailable=e=>chunks.push(e.data);
 recorder.onstop=async()=>{
  media.getTracks().forEach(track=>track.stop());
  q('#dictate').textContent='Dictate';
  const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});
  recorder=null;
  runStatus.textContent='Transcribing…';
  const response=await api('/v1/transcribe',{method:'POST',headers:{'content-type':blob.type},body:blob});
  const body=await response.json();
  if(!response.ok)return runStatus.textContent=body.message;
  const field=q('#turn-text');
  field.value=(field.value?field.value+' ':'')+body.text;
  runStatus.textContent='Transcribed.';
 };
 recorder.start();
 q('#dictate').textContent='Stop recording';
 runStatus.textContent='Recording…';
};

const missionList=q('#missions'),missionNotice=q('#mission-notice');
const missionStreams=new Map();
async function loadMissionModels(){const response=await api('/v1/models');if(!response.ok)return;const available=(await response.json()).models||[];if(available.length)q('#mission-model').innerHTML=available.map(model=>'<option>'+esc(model)+'</option>').join('')}
function missionChildren(mission){return Array.isArray(mission.children)?mission.children:Object.values(mission.children||{})}
function usageText(usage={}){
 const parts=[];
 for(const [name,value] of Object.entries(usage))if(value!==undefined&&value!==null)parts.push(name+': '+value);
 return parts.join(' · ')||'No budget used yet';
}
function throttleText(mission){
 const t=mission.throttle;if(!t)return '';
 const batch='<p class="hint">Running up to '+esc(t.batchSize)+' of '+esc(mission.maxConcurrency)+' child agents at a time.</p>';
 return t.waitingUntil?batch+'<p class="status interrupted">Waiting for the model provider rate limit to reset at '+esc(new Date(t.waitingUntil).toLocaleTimeString())+'; queued agents resume automatically.</p>':batch;
}
function renderMission(mission){
 const state=mission.status||mission.state||'unknown',children=missionChildren(mission);
 const lanes=children.map(child=>'<div class="lane"><div class="task-top"><strong>'+esc(child.id||child.name||'Child')+'</strong><span class="status '+esc(child.state||child.status||'queued')+'">'+esc(child.state||child.status||'queued')+'</span></div><p>'+esc(child.objective||'')+'</p><p class="hint">'+esc(usageText(child.usage))+'</p>'+(child.error?'<p class="status failed">'+esc(child.error.message||child.error)+'</p>':'')+(child.result?'<p>'+esc(child.result.summary||child.result)+'</p>':'')+'</div>').join('');
 const evidence=[...(mission.evidence||[]),...children.flatMap(child=>child.evidence||[])];
 const evidenceHtml=evidence.length?'<details class="evidence"><summary>Evidence ('+evidence.length+')</summary>'+evidence.map(item=>'<p>'+esc(item.summary||item.name||item.path||JSON.stringify(item))+'</p>').join('')+'</details>':'';
 const controls=state==='completed'||state==='failed'||state==='cancelled'?'':'<div class="actions"><button class="secondary" data-mission-action="pause" data-mission-id="'+esc(mission.id)+'"'+(state==='interrupted'?' disabled':'')+'>Pause</button><button class="secondary" data-mission-action="resume" data-mission-id="'+esc(mission.id)+'"'+(state!=='interrupted'?' disabled':'')+'>Resume</button><button class="secondary" data-mission-action="cancel" data-mission-id="'+esc(mission.id)+'">Cancel</button></div>';
 return '<article class="task"><div class="task-top"><h3>'+esc(mission.title||mission.objective||mission.id)+'</h3><span class="status '+esc(state)+'">'+esc(state)+'</span></div>'+(mission.reason?'<p>'+esc(mission.reason)+'</p>':'')+throttleText(mission)+'<p class="hint">Mission '+esc(mission.id)+' · '+esc(usageText(mission.usage||mission.budgetUsage))+'</p><div class="mission-lanes">'+lanes+'</div>'+evidenceHtml+controls+'</article>';
}
async function loadMissions(){
 if(!sessionStorage.getItem('atlas-token')){missionList.innerHTML='<p class="empty">Unlock this tab to load missions.</p>';return}
 const response=await api('/v1/missions');
 if(response.status===401){missionList.innerHTML='<p class="empty">Your access token was rejected. Unlock this tab again.</p>';return}
 if(!response.ok){const body=await response.json().catch(()=>({}));missionNotice.textContent=body.message||'Missions could not be loaded ('+response.status+').';return}
 const list=((await response.json()).missions||[]).filter(m=>missionChildren(m)[0]?.metadata?.kind!=='agent_step');
 missionNotice.textContent='';missionList.innerHTML=list.length?list.map(renderMission).join(''):'<p class="empty">No missions yet.</p>';
 missionList.querySelectorAll('[data-mission-action]').forEach(button=>button.onclick=()=>controlMission(button.dataset.missionId,button.dataset.missionAction));
 list.filter(m=>!['completed','failed','cancelled'].includes(m.status||m.state)).forEach(m=>watchMission(m.id));
}
async function controlMission(id,action){
 missionNotice.textContent=action[0].toUpperCase()+action.slice(1)+' requested…';
 const response=await api('/v1/missions/'+encodeURIComponent(id)+'/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
 const body=await response.json().catch(()=>({}));
 missionNotice.textContent=response.ok?'Mission '+action+' accepted.':body.message||'Mission '+action+' failed ('+response.status+').';
 await loadMissions();
}
async function watchMission(id){
 if(missionStreams.has(id))return;
 const controller=new AbortController();missionStreams.set(id,controller);let after=0;
 try{
  const response=await api('/v1/missions/'+encodeURIComponent(id)+'/events?after='+after,{signal:controller.signal});
  if(!response.ok||!response.body)return;
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let boundary=buffer.indexOf('\\n\\n');while(boundary!==-1){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const data=frame.split('\\n').find(line=>line.startsWith('data: '));if(data){const event=JSON.parse(data.slice(6));after=event.sequence||after;await loadMissions()}boundary=buffer.indexOf('\\n\\n')}}
 }catch(error){if(error.name!=='AbortError')missionNotice.textContent='Live mission updates disconnected; polling will continue.'}
 finally{missionStreams.delete(id)}
}
q('#mission-form').onsubmit=async event=>{
 event.preventDefault();let children;
 try{children=JSON.parse(q('#mission-lanes').value)}catch{return missionNotice.textContent='Child lanes must be valid JSON.'}
 if(!Array.isArray(children)||!children.length)return missionNotice.textContent='Add at least one child lane.';
 if(children.some(child=>!child||typeof child.id!=='string'||typeof child.objective!=='string'))return missionNotice.textContent='Every child lane needs a text id and objective.';
 if(children.some(child=>!Array.isArray(child.dependencies)))return missionNotice.textContent='Every child lane needs a dependencies array. Use [] when it has none.';
 const title=q('#mission-objective').value.trim(),repository=q('#mission-repository').value.trim(),model=q('#mission-model').value,maxConcurrency=Number(q('#mission-concurrency').value);
 missionNotice.textContent='Creating mission…';
 const response=await api('/v1/missions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repository,model,title,children,maxConcurrency})});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)return missionNotice.textContent=body.message||'Mission creation failed ('+response.status+').';
 missionNotice.textContent='Mission created.';q('#mission-lanes').value='';await loadMissions();
};
q('#mission-refresh').onclick=loadMissions;
q('#save-token').addEventListener('click',()=>{loadMissions();loadMissionModels()});
if(sessionStorage.getItem('atlas-token')){loadMissions();loadMissionModels()}
setInterval(()=>{if(sessionStorage.getItem('atlas-token'))loadMissions()},5000);

/* ---- Shell: sections, theme, lock state, and the views built on the platform APIs. ---- */
const VIEWS={home:'Home',command:'Command center',automations:'Automations',build:'Build',missions:'Missions',improve:'Improve Atlas',models:'Models',families:'Agent families',computer:'Computer',projects:'Projects',knowledge:'Knowledge',connections:'Connections',approvals:'Approvals',settings:'Settings'};
const $=q,$$=s=>[...document.querySelectorAll(s)];
const isUnlocked=()=>Boolean(sessionStorage.getItem('atlas-token'));
let currentView='home',openMissionId=null,shownMission='';
function setNotice(text){notice.textContent=text||'';if(text)setTimeout(()=>{if(notice.textContent===text)notice.textContent=''},6000)}
/* Errors say what happened and, when the API knows, how to unblock it. */
function problem(error){return '<div class="error"><strong>'+esc(error.message||'Something went wrong.')+'</strong>'+(error.unblock?'<p>'+esc(error.unblock)+'</p>':'')+'</div>'}
async function getJson(url,options){
 const response=await api(url,options);
 const body=await response.json().catch(()=>({}));
 if(!response.ok){const error=new Error(body.message||('The request failed ('+response.status+').'));error.status=response.status;error.unblock=body.unblock||null;throw error}
 return body;
}
const sendJson=(url,method,body)=>getJson(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const when=v=>v?new Date(v).toLocaleString():'';
/* An interrupted or paused mission waits for the owner; say that rather than the task's running state. */
const missionState=m=>['interrupted','paused'].includes(m.status)?m.status:(m.taskStatus||m.status);
const pill=s=>'<span class="status '+esc(String(s||'unknown').replace(/[^a-z_]/gi,''))+'">'+esc(String(s||'unknown').replaceAll('_',' '))+'</span>';

/* Theme: device preference unless the owner picks one. */
function applyTheme(choice){if(choice==='light'||choice==='dark')document.documentElement.dataset.theme=choice;else delete document.documentElement.dataset.theme;$('#theme-select').value=choice||'system'}
function savedTheme(){try{return localStorage.getItem('atlas-theme')||'system'}catch{return 'system'}}
function saveTheme(choice){try{localStorage.setItem('atlas-theme',choice)}catch{/* private mode: this tab only */}applyTheme(choice)}
applyTheme(savedTheme());
$('#theme-select').onchange=e=>saveTheme(e.target.value);
$('#theme').onclick=()=>{const dark=document.documentElement.dataset.theme?document.documentElement.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;saveTheme(dark?'light':'dark')};

/* Navigation */
const openNav=()=>{document.body.classList.add('nav-open');$('#scrim').hidden=false};
const closeNav=()=>{document.body.classList.remove('nav-open');$('#scrim').hidden=true};
$('#menu').onclick=openNav;$('#tab-more').onclick=openNav;$('#scrim').onclick=closeNav;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeNav()});
/* Routes are #/name so they never collide with element ids (a fragment that
   targets an id inside a closed <details> would open it and jump there). */
const viewFromHash=()=>location.hash.replace(/^#\\/?/,'').split('/')[0]||'home';
function show(view){
 if(!VIEWS[view])view='home';currentView=view;
 $$('.view').forEach(v=>{v.hidden=v.dataset.view!==view});
 $$('[data-nav]').forEach(a=>a.setAttribute('aria-current',a.dataset.nav===view?'page':'false'));
 $('#view-title').textContent=VIEWS[view];document.title=VIEWS[view]+' · Atlas';
 closeNav();refreshView();
}
window.addEventListener('hashchange',()=>{show(viewFromHash());$('#content').focus({preventScroll:true})});

function syncLock(){
 $('#unlock').hidden=isUnlocked();
 if(isUnlocked()&&transcript.querySelector('.empty'))transcript.innerHTML='<p class="empty">Send a message to start a conversation.</p>';
}
$('#save-token').addEventListener('click',()=>{syncLock();refreshView()});
$('#lock').onclick=()=>{try{localStorage.removeItem('atlas-device-token')}catch{}sessionStorage.removeItem('atlas-token');sessionStorage.removeItem('atlas-session');location.reload()};

/* Improve Atlas: start a run, watch it, and approve or reject what it produced. */
async function loadImprove(){
 const log=$('#improve-log'),pendingBox=$('#improve-pending'),recentBox=$('#improve-recent');
 try{
  const s=await getJson('/v1/self-improve');
  $('#improve-state').innerHTML=pill(s.running?'running':'idle')+' <span class="chip">streak '+esc(String(s.streak))+'</span>';
  $('#improve-start').disabled=s.running;
  log.textContent=s.log.length?s.log.join('\\n'):'No run yet. Press "Improve yourself" to start one.';
  log.scrollTop=log.scrollHeight;
  const badge=$('#improve-badge');badge.hidden=!s.pending.length;badge.textContent=String(s.pending.length);
  pendingBox.innerHTML=s.pending.length?s.pending.map(c=>'<article class="task"><div class="task-top"><h4>'+esc(c.kind||'change')+'</h4>'+pill('accepted')+'</div><p>'+esc(c.objective||'')+'</p><p class="hint">Why: '+esc(c.reason||'')+'</p><div class="meta"><span><code>'+esc(c.branch)+'</code></span><span>'+esc(String(c.stats?.files??0))+' files, +'+esc(String(c.stats?.added??0))+'/−'+esc(String(c.stats?.deleted??0))+'</span>'+(c.review?.summary?'<span>Reviewer: '+esc(c.review.summary)+'</span>':'')+'</div><div class="actions"><button data-improve="approve" data-id="'+esc(c.id)+'">Merge into my branch</button><button class="secondary" data-improve="reject" data-id="'+esc(c.id)+'">Reject</button></div></article>').join(''):'<p class="empty">Nothing waiting.</p>';
  pendingBox.querySelectorAll('[data-improve]').forEach(b=>b.onclick=()=>decideImprove(b.dataset.id,b.dataset.improve));
  recentBox.innerHTML=s.recent.length?s.recent.map(r=>'<article class="task"><div class="task-top"><h4>'+esc(r.kind||r.outcome)+'</h4>'+pill(r.outcome)+'</div>'+(r.objective?'<p>'+esc(r.objective)+'</p>':'')+((r.violations||[]).length?'<p class="hint">'+esc(r.violations.map(v=>v.detail).join(' · '))+'</p>':(r.reason&&!r.objective?'<p class="hint">'+esc(r.reason)+'</p>':''))+'<time>'+when(r.at)+'</time></article>').join(''):'<p class="empty">No attempts yet.</p>';
 }catch(error){log.textContent='';pendingBox.innerHTML=problem(error)}
}
async function decideImprove(id,action){
 const notice=$('#improve-notice');
 if(action==='approve'&&!confirm('Merge this change into your current branch?'))return;
 try{await sendJson('/v1/self-improve/changes/'+encodeURIComponent(id)+'/'+action,'POST',{});notice.textContent=action==='approve'?'Merged into your branch.':'Rejected; the branch was deleted.'}
 catch(error){notice.textContent=error.message}
 loadImprove();
}
$('#improve-form').onsubmit=async e=>{e.preventDefault();const notice=$('#improve-notice');try{await sendJson('/v1/self-improve/runs','POST',{iterations:Number($('#improve-iterations').value)||1});notice.textContent='Started. Progress appears below.'}catch(error){notice.textContent=error.message}loadImprove()};
$('#improve-refresh').onclick=()=>loadImprove();

/* Models: install, run and choose local models without configuring a server by hand. */
let modelsOverview=null;
function gib(n){return n==null?'?':(Math.round(n*10)/10)+' GB'}
async function loadModels(){
 const machine=$('#models-machine'),planBox=$('#models-plan'),catalogBox=$('#models-catalog');
 try{
  const o=modelsOverview=await getJson('/v1/models/hosting');
  const h=o.hardware,r=o.runtime;
  $('#models-runtime-state').innerHTML=pill(r.reachable?'running':'stopped')+(r.managed?' <span class="chip">started by Atlas</span>':'')+(r.version?' <span class="chip">Ollama '+esc(r.version)+'</span>':'');
  machine.innerHTML='<dl class="kv"><dt>Runs models on</dt><dd>'+esc(h.accelerator==='cpu'?'CPU ('+h.cpuCount+' cores)':h.accelerator==='apple'?'Apple Silicon GPU (unified memory)':(h.gpus||[]).map(g=>g.name+' · '+g.memoryGiB+' GB').join(', '))+'</dd><dt>Memory for models</dt><dd>'+esc(String(h.usableModelMemoryGiB))+' GB of '+esc(String(h.totalMemoryGiB))+' GB ('+esc(String(h.freeMemoryGiB??'?'))+' GB free now)</dd><dt>Loaded</dt><dd>'+esc((r.loaded||[]).map(m=>m.tag+(m.context?' · '+m.context+' ctx':'')+(m.memoryGB?' · '+m.memoryGB+' GB':'')).join(', ')||'nothing')+'</dd></dl>'+(r.binary==='missing'?'<div class="error"><strong>No local model runtime is installed.</strong><p>Install Ollama from <a href="'+esc(r.installGuide)+'" target="_blank" rel="noopener">ollama.com/download</a>, then press Start model server. Atlas manages it from there.</p></div>':'')+((r.jobs||[]).filter(j=>j.state==='running').map(j=>'<p class="hint">Installing '+esc(j.tag)+': '+esc(j.status)+'</p><progress max="100" value="'+esc(String(j.percent||0))+'"></progress>').join(''))+((r.jobs||[]).filter(j=>j.state==='failed').slice(-2).map(j=>'<p class="hint">'+esc(j.tag)+' failed: '+esc(j.status)+'</p>').join(''));
  const rec=o.recommended,applied=o.applied;
  const role=(name,e)=>e?'<tr><td>'+name+'</td><td><code>'+esc(e.tag)+'</code></td><td>'+esc(String(e.context||''))+'</td><td>'+(e.installed===false?'needs '+gib(e.downloadGB)+' download':'installed')+'</td></tr>':'';
  planBox.innerHTML='<p class="hint">'+esc(rec.summary)+'</p><table class="table"><thead><tr><th>Role</th><th>Model</th><th>Context</th><th></th></tr></thead><tbody>'+role('Coding',rec.coder)+role('Reviewing',rec.reviewer)+role('Quick tasks',rec.fast)+'</tbody></table>'+(applied?'<p class="hint">In use: coding <code>'+esc(applied.coder.tag)+'</code>'+(applied.reviewer?', reviewing <code>'+esc(applied.reviewer.tag)+'</code>':'')+(applied.fast?', quick tasks <code>'+esc(applied.fast.tag)+'</code>':'')+'.</p>':'<p class="hint">No plan applied yet; Atlas uses its default model.</p>')+(rec.missing.length?'<div class="actions">'+rec.missing.map(t=>'<button type="button" class="secondary" data-model-install="'+esc(t)+'">Install '+esc(t)+'</button>').join('')+'</div>':'');
  const running=new Set((r.jobs||[]).filter(j=>j.state==='running').map(j=>j.tag));
  catalogBox.innerHTML=o.catalog.map(m=>'<article class="task"><div class="task-top"><h4>'+esc(m.tag)+'</h4>'+pill(m.installed?'installed':m.fits?'fits':'too large')+'</div><div class="meta"><span>coding '+esc(String(m.coding))+'/10</span><span>reasoning '+esc(String(m.reasoning))+'/10</span><span>'+esc(gib(m.downloadGB))+' download</span><span>'+(m.fits?'~'+esc(gib(m.memoryGiB))+' at '+esc(String(m.context))+' ctx':'needs ~'+esc(gib(m.memoryGiB)))+'</span>'+(m.activeB<m.parametersB?'<span>mixture of experts: fast for its size</span>':'')+(m.tools?'':'<span>no tool calls</span>')+(m.vision?'<span>vision</span>':'')+'</div><div class="actions">'+(m.installed?'<button type="button" data-model-warm="'+esc(m.tag)+'" data-context="'+esc(String(m.context||8192))+'"'+(m.fits?'':' disabled')+'>Run</button><button type="button" class="secondary" data-model-remove="'+esc(m.tag)+'">Remove</button>':'<button type="button" data-model-install="'+esc(m.tag)+'"'+(running.has(m.tag)?' disabled':'')+'>'+(running.has(m.tag)?'Installing…':'Install')+'</button>')+'</div></article>').join('');
  $$('[data-model-install]').forEach(b=>b.onclick=()=>modelAction('install',{tag:b.dataset.modelInstall},'Downloading '+b.dataset.modelInstall+'…'));
  $$('[data-model-remove]').forEach(b=>b.onclick=()=>{if(confirm('Remove '+b.dataset.modelRemove+' from this computer?'))modelAction('remove',{tag:b.dataset.modelRemove},'Removed.')});
  $$('[data-model-warm]').forEach(b=>b.onclick=()=>modelAction('warm',{tag:b.dataset.modelWarm,context:Number(b.dataset.context)},'Loading '+b.dataset.modelWarm+'…'));
 }catch(error){machine.innerHTML=problem(error)}
}
async function modelAction(action,body,pending){
 const notice=$('#models-notice');notice.textContent=pending;
 try{const result=await sendJson('/v1/models/hosting/'+action,'POST',body);notice.textContent=action==='warm'?result.loaded+' is loaded with a '+result.context+'-token context.':action==='install'?'Downloading '+result.job.tag+'. Progress appears above.':action==='plan'?'Atlas now uses '+result.applied.coder.tag+' for coding.':action==='server'?(result.stopped===false?'Atlas did not start this server, so it left it running.':result.stopped?'Stopped.':result.started?'Started the model server.':'The model server is already running.'):pending}
 catch(error){notice.textContent=error.message+(error.unblock?' '+error.unblock:'')}
 loadModels();
}
$('#models-start').onclick=()=>modelAction('server',{action:'start'},'Starting the model server…');
$('#models-stop').onclick=()=>modelAction('server',{action:'stop'},'Stopping…');
$('#models-apply').onclick=()=>modelAction('plan',{},'Applying…');
$('#models-refresh').onclick=()=>loadModels();

/* Remote access: customer-managed VPN or HTTPS proxy, and device pairing. */
if(pairFromLink)$('#pair-code-input').value=pairFromLink;
$('#pair-form').onsubmit=async e=>{e.preventDefault();const status=$('#pair-status');status.textContent='Pairing…';
 try{const r=await fetch('/v1/pair/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:$('#pair-code-input').value.trim(),name:$('#pair-name').value.trim()||'My phone'})});const v=await r.json();if(!r.ok)throw new Error(v.message||'Pairing failed.');
  try{localStorage.setItem('atlas-device-token',v.deviceToken)}catch{}sessionStorage.setItem('atlas-token',v.deviceToken);status.textContent='Paired as '+v.device.name+'.';syncLock();refreshView()}
 catch(error){status.textContent=error.message}};
async function loadRemote(){
 const box=$('#remote-status');
 try{
  const r=await getJson('/v1/remote'),t=r.tailscale,st=r.settings;
  box.innerHTML='<dl class="kv"><dt>Atlas listens on</dt><dd>'+esc(r.listening)+' (this computer only)</dd><dt>Remote access</dt><dd>'+(st.mode==='off'?'off':esc(st.mode==='tailscale'?'Tailscale (private tailnet)':'your HTTPS proxy')+(st.url?' · <code>'+esc(st.url)+'</code>':''))+'</dd><dt>Tailscale</dt><dd>'+(!t.installed?'not installed':t.running?'connected as '+esc(t.dnsName||'this machine')+(t.serving?' · serving Atlas':''):esc(t.message||'not running'))+'</dd></dl>';
  $('#remote-guides').textContent='Caddy (automatic HTTPS):\\n'+r.guides.caddy+'\\nnginx:\\n'+r.guides.nginx+'\\nTailscale, by hand:\\n'+r.guides.tailscale;
  $('#remote-owner').checked=st.ownerRemote;$('#remote-owner').disabled=st.mode==='off';
  $('#remote-tailscale').disabled=!t.running||t.serving;
  if(st.url&&!$('#remote-proxy-url').value&&st.mode==='proxy')$('#remote-proxy-url').value=st.url;
  return r;
 }catch(error){box.innerHTML=problem(error);return null}
}
async function remoteAction(path,body,pending){const notice=$('#remote-notice');notice.textContent=pending;try{const v=await sendJson(path,'POST',body);notice.textContent=v.check?v.check.message:'Done.'}catch(error){notice.textContent=error.message}loadRemote()}
$('#remote-tailscale').onclick=()=>remoteAction('/v1/remote/tailscale',{action:'enable'},'Asking Tailscale to serve Atlas on your tailnet…');
$('#remote-off').onclick=()=>remoteAction('/v1/remote/off',{},'Turning off…');
$('#remote-proxy-form').onsubmit=e=>{e.preventDefault();remoteAction('/v1/remote/proxy',{url:$('#remote-proxy-url').value.trim()},'Checking the address…')};
$('#remote-owner').onchange=e=>remoteAction('/v1/remote/owner',{allow:e.target.checked},'Saving…');
$('#remote-pair').onclick=async()=>{const out=$('#remote-pair-code');try{const [v,r]=await Promise.all([sendJson('/v1/pair','POST',{}),getJson('/v1/remote').catch(()=>null)]);const link=r&&r.settings.url?r.settings.url+'/#pair='+v.code:null;out.innerHTML='Code <strong>'+esc(v.code)+'</strong>, valid until '+esc(new Date(v.expiresAt).toLocaleTimeString())+'.'+(link?' On your phone open <code>'+esc(link)+'</code>':' Turn on remote access to get a link for your phone.')}catch(error){out.textContent=error.message}};

/* Build (Project Genesis): one sentence in, a working local application out. */
const GEN_ACTIVE=['scaffolding','building','verifying','previewing','repairing','reviewing','publishing'];
function genIcon(step){return step.done?'✓':step.status==='running'?'●':step.status==='failed'?'✗':step.status==='blocked'?'!':step.status==='skipped'?'–':'○'}
async function loadBuild(){
 const list=$('#build-projects'),detail=$('#build-detail');
 const id=location.hash.split('/')[2]||'';
 /* Do not redraw under someone typing an answer or a change. */
 if(detail.contains(document.activeElement)&&document.activeElement.matches('input,textarea'))return;
 try{
  const {projects}=await getJson('/v1/genesis');
  list.innerHTML=projects.length?projects.map(p=>'<a class="card" href="#/build/'+esc(p.id)+'"><div class="task-top"><h4>'+esc(p.name)+'</h4>'+pill(p.label)+'</div><time>'+when(p.updatedAt)+'</time></a>').join(''):'<p class="empty">Nothing built yet. Describe an app above.</p>';
  if(!id){detail.hidden=true;return}
  const {project:v}=await getJson('/v1/genesis/'+encodeURIComponent(id));
  const ready=v.transitions.findLast(t=>t.to==='ready')?.evidence?.summary;
  const last=v.transitions.at(-1);
  const online=v.transitions.findLast(t=>t.evidence?.kind==='deployed')?.evidence?.deployment?.url;
  const publishedTo=v.transitions.findLast(t=>t.evidence?.kind==='published')?.evidence;
  const where=(online?'<p>Online at <a href="'+esc(online)+'" target="_blank" rel="noopener">'+esc(online)+'</a></p>':'')+(publishedTo?'<p class="hint">Code published to '+esc(publishedTo.repository?.webUrl||publishedTo.remote||'')+'</p>':'');
  const questions=v.state==='blocked'&&v.resumeTo==='requirements'?v.spec.questions:[];
  const actions=[];
  if(GEN_ACTIVE.includes(v.state)||v.state==='approved')actions.push('<button type="button" class="secondary" data-gen="pause">Pause</button>');
  if(v.state==='paused'||(v.state==='blocked'&&!questions.length))actions.push('<button type="button" data-gen="resume">Resume</button>');
  if(v.state==='planned')actions.push('<button type="button" data-gen="approve">Approve plan</button>');
  if(v.state==='failed')actions.push('<button type="button" data-gen="retry">Try again</button>');
  if(!['cancelled'].includes(v.state))actions.push('<button type="button" class="secondary" data-gen="cancel">Cancel</button>');
  detail.hidden=false;
  detail.innerHTML='<div class="panel"><div class="task-top"><h3>'+esc(v.name)+'</h3>'+pill(v.label)+'</div>'
   +(ready?'<div class="card success"><h4>Ready</h4><p><a class="button" href="'+esc(ready.preview)+'" target="_blank" rel="noopener">Open the application</a></p><p>'+esc(ready.features.join(' · '))+'</p><p class="hint">Verified: '+esc(ready.verification.map(x=>x.step+(x.ok?' ✓':' ✗')+(x.tests?' ('+x.tests.pass+' tests)':'')).join(', '))+'; interface checked '+(ready.inspection.limited?'over HTTP only':'in a browser')+(ready.repairs?'; '+ready.repairs+' repair(s)':'')+'.</p>'+(ready.limitations.length?'<ul class="hint">'+ready.limitations.map(l=>'<li>'+esc(l)+'</li>').join('')+'</ul>':'')+'<p class="hint">Files: <code>'+esc(ready.folder)+'</code></p>'+where+'</div>':'')
   +(!ready||v.state!=='ready'?'<p>'+esc(last?.reason||'')+'</p>':'')
   +(questions.length?'<form id="gen-answers" class="card"><h4>Atlas needs to know</h4>'+questions.map(q=>'<label>'+esc(q.question)+'<input name="'+esc(q.id)+'" placeholder="'+esc(q.default||'')+'"></label>').join('')+'<button>Answer</button></form>':'')
   +'<ol class="steps-list">'+v.progress.steps.map(s=>'<li class="step '+(s.done?'done':s.status||'')+'"><span aria-hidden="true">'+genIcon(s)+'</span> '+esc(s.label)+(s.attempts>1?' <span class="hint">('+s.attempts+' attempts)</span>':'')+'</li>').join('')+'</ol>'
   +'<div class="actions">'+actions.join('')+'</div>'
   +(['ready','published'].includes(v.state)?'<details class="card"><summary>Publish or put it online</summary>'
     +'<form id="gen-publish" class="row"><label class="grow">Push to a repository you already created<input id="gen-publish-remote" placeholder="https://github.com/you/app.git"></label><button class="secondary">Publish…</button></form>'
     +'<form id="gen-repo" class="row"><label>Create a repository on<select id="gen-repo-host"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label><label>Visibility<select id="gen-repo-visibility"><option value="private">Private</option><option value="public">Public</option></select></label><button class="secondary">Create and publish…</button></form>'
     +(v.plan?.template==='static-site'?'<form id="gen-deploy" class="row"><label>Put the website online with Vercel<select id="gen-deploy-target"><option value="preview">Preview address</option><option value="production">Production address</option></select></label><button class="secondary">Deploy…</button></form>':'<p class="hint">This app runs its own server and database, so it stays on this computer (reach it from your phone under Settings → Reach Atlas) or on a server you control.</p>')
     +'<p class="hint">Nothing leaves this computer until you approve it under Approvals. Creating repositories and deploying use tokens you add as ATLAS_GITHUB_TOKEN, ATLAS_GITLAB_TOKEN or ATLAS_VERCEL_TOKEN.</p></details>':'')
   +(['ready','published','failed','planned','approved'].includes(v.state)?'<form id="gen-change" class="row"><label class="grow">Ask for a change<input id="gen-change-text" placeholder="Add Google login"></label><button>Change it</button></form>':'')
   +'<details><summary>Assumptions</summary><ul>'+(v.spec?.assumptions||[]).map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul></details>'
   +'<details><summary>Technical details</summary><p class="hint">Template '+esc(v.plan?.template||'—')+' · folder <code>'+esc(v.workspace||'not created yet')+'</code> · repairs '+v.repairsUsed+'/'+v.repairBudget+'</p><table class="table"><thead><tr><th>When</th><th>Stage</th><th>Why</th></tr></thead><tbody>'+v.transitions.slice().reverse().map(t=>'<tr><td>'+when(t.at)+'</td><td>'+esc(t.to)+'</td><td>'+esc(t.reason)+'<details><summary>Evidence</summary><pre class="log">'+esc(JSON.stringify(t.evidence,null,1).slice(0,6000))+'</pre></details></td></tr>').join('')+'</tbody></table></details></div>';
  detail.querySelectorAll('[data-gen]').forEach(b=>b.onclick=()=>genAction(v.id,b.dataset.gen,{}));
  const answers=detail.querySelector('#gen-answers');
  if(answers)answers.onsubmit=e=>{e.preventDefault();genAction(v.id,'answers',{answers:Object.fromEntries(new FormData(answers).entries())})};
  const external=async(action,body)=>{const notice=$('#build-notice');notice.textContent='Asking…';
   try{const r=await sendJson('/v1/genesis/'+encodeURIComponent(v.id)+'/'+action,'POST',body);const p=r.publish;notice.textContent=p.status==='awaiting-approval'?'Waiting for your approval under Approvals.':p.status==='deployed'?'Online at '+p.deployment.url:p.status==='published'?'Published.':'Did not complete: '+(p.message||'')}catch(error){notice.textContent=error.message}loadBuild();loadBadge().catch(()=>{})};
  const repo=detail.querySelector('#gen-repo');
  if(repo)repo.onsubmit=e=>{e.preventDefault();external('repository',{host:$('#gen-repo-host').value,visibility:$('#gen-repo-visibility').value})};
  const deploy=detail.querySelector('#gen-deploy');
  if(deploy)deploy.onsubmit=e=>{e.preventDefault();external('deploy',{target:$('#gen-deploy-target').value})};
  const publish=detail.querySelector('#gen-publish');
  if(publish)publish.onsubmit=async e=>{e.preventDefault();const remote=$('#gen-publish-remote').value.trim();if(!remote)return;const notice=$('#build-notice');
   try{const r=await sendJson('/v1/genesis/'+encodeURIComponent(v.id)+'/publish','POST',{remote});notice.textContent=r.publish.status==='awaiting-approval'?'Waiting for your approval under Approvals.':r.publish.status==='published'?'Published.':'Publishing failed: '+(r.publish.message||'')}catch(error){notice.textContent=error.message}loadBuild();loadBadge().catch(()=>{})};
  const change=detail.querySelector('#gen-change');
  if(change)change.onsubmit=e=>{e.preventDefault();const request=$('#gen-change-text').value.trim();if(request)genAction(v.id,'changes',{request})};
 }catch(error){(id?detail:list).innerHTML=problem(error);if(id)detail.hidden=false}
}
async function genAction(id,action,body){
 const notice=$('#build-notice');
 if(action==='cancel'&&!confirm('Cancel this project? Its files stay on this computer.'))return;
 try{await sendJson('/v1/genesis/'+encodeURIComponent(id)+'/'+action,'POST',body);notice.textContent=''}catch(error){notice.textContent=error.message}
 loadBuild();
}
$('#build-form').onsubmit=async e=>{e.preventDefault();const prompt=$('#build-prompt').value.trim();const notice=$('#build-notice');if(!prompt){notice.textContent='Describe what to build.';return}
 $('#build-start').disabled=true;notice.textContent='Understanding your idea…';
 try{const {project}=await sendJson('/v1/genesis','POST',{prompt});$('#build-prompt').value='';notice.textContent='';location.hash='#/build/'+project.id}
 catch(error){notice.textContent=error.message}finally{$('#build-start').disabled=false}};
$$('#build-examples [data-example]').forEach(b=>b.onclick=()=>{$('#build-prompt').value=b.dataset.example;$('#build-prompt').focus()});
$('#build-refresh').onclick=()=>loadBuild();

function refreshView(){
 if(!isUnlocked())return;
 const run={home:loadHome,command:loadCommand,automations:loadAutomations,missions:loadTeam,improve:loadImprove,models:loadModels,build:loadBuild,families:loadFamilies,computer:loadComputer,knowledge:loadKnowledge,connections:loadConnections,settings:loadRemote}[currentView];
 if(run)run().catch(()=>{});
 loadBadge().catch(()=>{});
}

/* ---- Command center: every running thing, with per-lane control. ---- */
const COMMAND_KINDS={goal:'Goal (sleeps between events)',operator:'Computer operation',suggestion:'Suggestion',automation:'Automation',mission:'Coder lanes',team:'Team mission',genesis:'Genesis build',task:'Coding task',improve:'Improve Atlas'};
const COMMAND_BUCKETS={attention:'Needs you',running:'Running',waiting:'Waiting',done:'Recently finished'};
function commandButtons(actions,key){return (actions||[]).map((a,i)=>'<button type="button" class="'+(a.name==='cancel'?'ghost':'secondary')+'" data-command="'+esc(key)+'" data-index="'+i+'">'+esc(a.label)+'</button>').join('')}
/* A lane's kernel run, step by step: what it set out to do, the capabilities it had, each action, and the check. */
const openTraces=new Set();
const TRACE_PHASES={goal:'Goal',mount:'Capabilities',perceive:'Looked at what Atlas knows',retrieve:'Recalled',plan:'Attempt',act:'Action',observe:'Observed',verify:'Check',decide:'Next',finish:'Finished'};
function traceDetail(e){const d=e.data||{};
 if(e.phase==='goal')return d.title||'';
 if(e.phase==='mount')return (d.capabilities||[]).map(c=>c.name).join(', ')+((d.gaps||[]).length?' · missing: '+d.gaps.join(', '):'');
 if(e.phase==='perceive')return (d.entities||0)+' related things';
 if(e.phase==='retrieve')return (d.memories||0)+' memories'+(d.upstream?', earlier steps':'');
 if(e.phase==='plan')return 'attempt '+(d.attempt||1);
 if(e.phase==='act')return (d.tool||d.harness||'')+(d.status?' · '+d.status:'');
 if(e.phase==='observe')return d.ok?'succeeded'+((d.artifacts||[]).length?' · '+d.artifacts.join(', '):''):(d.cancelled?'cancelled':'failed');
 if(e.phase==='verify')return (d.passed?'passed':'not yet')+(d.reason?' · '+d.reason:'');
 if(e.phase==='decide')return (d.next||'')+(d.reason?' · '+d.reason:'');
 if(e.phase==='finish')return d.passed?'verified':'not verified';
 return ''}
async function loadTrace(d){const r=await getJson(d.dataset.trace);
 d.querySelector('ol').innerHTML=(r.trace||[]).length?r.trace.map(e=>'<li><strong>'+esc(TRACE_PHASES[e.phase]||e.phase)+'</strong> <span class="hint">'+esc(traceDetail(e))+'</span></li>').join(''):'<li class="hint">No steps recorded.</li>'}
async function loadCommand(){
 const list=$('#command-items');
 if(list.contains(document.activeElement)&&document.activeElement.matches('button'))return;
 let view;
 try{view=await getJson('/v1/command-center')}catch(error){list.innerHTML=problem(error);return}
 const c=view.counts;
 $('#command-counts').innerHTML=['attention','running','waiting'].map(b=>'<span class="chip">'+esc(COMMAND_BUCKETS[b])+' · '+c[b]+'</span>').join('')+'<span class="chip">Lanes running · '+c.lanesRunning+'</span>';
 const registry=new Map();
 let bucket='';
 list.innerHTML=view.items.length?view.items.map((item,n)=>{
  const key='i'+n;registry.set(key,item.actions||[]);
  const heading=item.bucket!==bucket?'<h3 class="command-bucket">'+esc(COMMAND_BUCKETS[item.bucket])+'</h3>':'';bucket=item.bucket;
  const lanes=(item.lanes||[]).map((lane,m)=>{const laneKey=key+'l'+m;registry.set(laneKey,lane.actions||[]);
   return '<li class="lane'+(lane.recommended?' recommended':'')+'"><div class="task-top"><span>'+esc(lane.title)+(lane.agent?' <span class="hint">· '+esc(lane.agent)+'</span>':'')+(lane.recommended?' <span class="chip">Recommended</span>':'')+'</span>'+pill(lane.held?'paused':lane.state)+'</div>'+(lane.message&&lane.state!=='completed'?'<p class="hint">'+esc(lane.message)+'</p>':'')+(lane.result?'<details><summary>Result</summary>'+(lane.result.summary?'<pre class="log">'+esc(lane.result.summary)+'</pre>':'')+(lane.result.patch?'<p class="hint">Patch: <code>'+esc(lane.result.patch)+'</code></p>':'<p class="hint">No changes were produced.</p>')+'</details>':'')+(lane.trace?'<details class="trace" data-trace="'+esc(lane.trace)+'"'+(openTraces.has(lane.trace)?' open':'')+'><summary>How it ran</summary><ol class="trace-steps"><li class="hint">Loading…</li></ol></details>':'')+'<div class="actions">'+commandButtons(lane.actions,laneKey)+'</div></li>'}).join('');
  return heading+'<article class="card"><div class="task-top"><h4><a href="'+esc(item.link)+'">'+esc(item.title)+'</a></h4>'+pill(item.state)+'</div>'
   +'<div class="meta"><span>'+esc(COMMAND_KINDS[item.kind]||item.kind)+'</span>'+(item.progress?'<span>'+item.progress.done+' of '+item.progress.total+' done</span>':'')+'<time>'+when(item.updatedAt)+'</time></div>'
   +(item.progress&&item.progress.total?'<progress max="'+item.progress.total+'" value="'+item.progress.done+'"></progress>':'')
   +(item.detail?'<p class="hint">'+esc(item.detail)+'</p>':'')
   +(item.modelChoice?'<p class="hint">Atlas chose the model '+esc(item.modelChoice.model)+': '+esc(item.modelChoice.reasons.join('; '))+'.</p>':'')
   +(item.strategy?'<p class="hint">Atlas chose '+(item.strategy.branch?item.strategy.versions+' competing versions':'one attempt')+': '+esc(item.strategy.reasons.join('; '))+'.</p>':'')
   +(lanes?'<ul class="lanes">'+lanes+'</ul>':'')
   +'<div class="actions">'+commandButtons(item.actions,key)+'</div></article>'}).join(''):'<p class="empty">Atlas is not doing anything right now. Start something from Home, Build or Missions.</p>';
 list.querySelectorAll('details.trace').forEach(d=>{
  const show=()=>loadTrace(d).catch(e=>{d.querySelector('ol').innerHTML='<li class="hint">'+esc(e.message)+'</li>'});
  d.addEventListener('toggle',()=>{if(d.open){openTraces.add(d.dataset.trace);show()}else openTraces.delete(d.dataset.trace)});
  if(d.open)show();
 });
 list.querySelectorAll('[data-command]').forEach(b=>b.onclick=async()=>{
  const act=(registry.get(b.dataset.command)||[])[Number(b.dataset.index)];if(!act)return;
  if(act.name==='cancel'&&!confirm('Cancel this? Work already finished is kept.'))return;
  const notice=$('#command-notice');b.disabled=true;notice.textContent='Asking Atlas to '+act.label.toLowerCase()+'…';
  try{const r=await sendJson(act.path,act.method,act.body);notice.textContent=r.apply?(r.apply.status==='awaiting-approval'?'Waiting for your approval under Approvals.':r.apply.message||''):''}catch(error){notice.textContent=error.message}
  b.blur();loadCommand().catch(()=>{});
 });
}
$('#command-refresh').onclick=()=>loadCommand();
$('#launch-mode').onchange=()=>{const mode=$('#launch-mode').value,v=mode==='variants';$('#launch-count-label').hidden=!v;$('#launch-text').placeholder=v?'Redesign the pricing page to make the Pro plan stand out':mode==='auto'?'Refactor the billing module so invoices can be retried':['Fix the login redirect','Add a CSV export to the reports page','Update the README'].join(String.fromCharCode(10))};
$('#command-launch-panel').addEventListener('toggle',async()=>{if(!$('#command-launch-panel').open)return;const r=await api('/v1/models');if(!r.ok)return;const m=(await r.json()).models||[];if(m.length)$('#launch-model').innerHTML='<option value="auto">Let Atlas choose (from past results)</option>'+m.map(x=>'<option>'+esc(x)+'</option>').join('')});
$('#command-launch').onsubmit=async e=>{e.preventDefault();const notice=$('#command-notice'),text=$('#launch-text').value.trim(),variants=$('#launch-mode').value==='variants';
 const body={repository:$('#launch-repository').value.trim(),model:$('#launch-model').value};
 if($('#launch-mode').value==='auto'){body.objective=text;body.strategy='auto'}else if(variants){body.objective=text;body.variants=Number($('#launch-count').value)}else{body.tasks=text.split(String.fromCharCode(10)).map(t=>t.trim()).filter(Boolean)}
 notice.textContent='Starting…';
 try{await sendJson('/v1/missions','POST',body);notice.textContent='Started.';$('#launch-text').value='';$('#command-launch-panel').open=false}catch(error){notice.textContent=error.message}
 loadCommand().catch(()=>{})};
$('#command-goal').onsubmit=async e=>{e.preventDefault();const notice=$('#command-notice');
 const body={objective:$('#goal-text').value.trim(),repository:$('#goal-repository').value.trim(),model:$('#goal-model').value.trim(),watch:{repository:$('#goal-watch').value.trim(),pullRequest:Number($('#goal-pr').value)}};
 notice.textContent='Starting…';
 try{await sendJson('/v1/goals','POST',body);notice.textContent='Started; Atlas will keep watching.';$('#goal-text').value='';$('#command-goal-panel').open=false}catch(error){notice.textContent=error.message}
 loadCommand().catch(()=>{})};
setInterval(()=>{if(currentView==='command'&&isUnlocked()&&!document.hidden)loadCommand().catch(()=>{})},4000);

/* ---- Automations ---- */
const triggerText=a=>a.trigger.kind==='schedule'?'Schedule '+a.trigger.cron:a.trigger.kind==='github'?'GitHub '+a.trigger.events.join(', ')+(a.trigger.branches.length?' on '+a.trigger.branches.join(', '):''):a.trigger.kind==='file'?'Files change in '+a.trigger.path:a.trigger.kind==='webhook'?'Webhook':'Run now only';
async function loadAutomations(){
 const list=$('#automations-list');
 /* #/automations/new/<mission>: "Automate this?" from the Command Center prefills the form. */
 const from=location.hash.split('/')[3];
 if(from){history.replaceState(null,'','#/automations');getJson('/v1/missions/'+encodeURIComponent(from)).then(({mission})=>{const lanes=mission.children||[];$('#automation-new-panel').open=true;$('#auto-name').value=(mission.title||'Repeated task').slice(0,120);$('#auto-kind').value='mission';$('#auto-repository').value=mission.repository||'';$('#auto-text').value=lanes.map(l=>l.objective).join(String.fromCharCode(10));syncAutomationForm()}).catch(()=>{})}
 let data;try{data=await getJson('/v1/automations')}catch(error){list.innerHTML=problem(error);return}
 list.innerHTML=data.automations.length?data.automations.map(a=>'<article class="card"><div class="task-top"><h4>'+esc(a.name)+'</h4>'+pill(a.enabled?'active':'paused')+'</div>'
  +'<div class="meta"><span>'+esc(triggerText(a))+'</span><span>'+esc(a.action.kind==='team'?'Team goal':a.action.tasks.length+' coding task(s)')+'</span>'+(a.nextRunAt&&a.enabled?'<span>Next '+when(a.nextRunAt)+'</span>':'')+'</div>'
  +(a.pausedReason?'<p class="hint">'+esc(a.pausedReason)+'</p>':'')
  +(a.lastRun?'<p class="hint">Last run '+when(a.lastRun.startedAt)+': '+esc(a.lastRun.status)+(a.lastRun.message?' · '+esc(a.lastRun.message):'')+'</p>':'')
  +'<div class="actions"><button type="button" class="secondary" data-auto="run" data-id="'+esc(a.id)+'">Run now</button>'+(a.enabled?'<button type="button" class="secondary" data-auto="pause" data-id="'+esc(a.id)+'">Pause</button>':'<button type="button" data-auto="resume" data-id="'+esc(a.id)+'">Resume</button>')+'<button type="button" class="ghost" data-auto="history" data-id="'+esc(a.id)+'">History</button><button type="button" class="ghost" data-auto="delete" data-id="'+esc(a.id)+'">Delete</button></div>'
  +'<div class="auto-history" data-history="'+esc(a.id)+'" hidden></div></article>').join(''):'<p class="empty">No automations yet. Create one above.</p>';
 list.querySelectorAll('[data-auto]').forEach(b=>b.onclick=()=>automationAction(b.dataset.id,b.dataset.auto));
}
async function automationAction(id,action){
 const notice=$('#automations-notice');
 try{
  if(action==='history'){const box=document.querySelector('[data-history="'+id+'"]');const {automation}=await getJson('/v1/automations/'+encodeURIComponent(id));box.hidden=false;box.innerHTML=automation.runs.length?'<table class="table"><thead><tr><th>Started</th><th>By</th><th>Result</th></tr></thead><tbody>'+automation.runs.map(r=>'<tr><td>'+when(r.startedAt)+'</td><td>'+esc(r.triggerKind)+'</td><td>'+esc(r.status)+(r.message?' · '+esc(r.message):'')+(r.missionId?' · <a href="#/command">see run</a>':'')+'</td></tr>').join('')+'</tbody></table>':'<p class="empty">No runs yet.</p>';return}
  if(action==='delete'){if(!confirm('Delete this automation and its history?'))return;await getJson('/v1/automations/'+encodeURIComponent(id),{method:'DELETE'});notice.textContent='Deleted.'}
  else{const r=await sendJson('/v1/automations/'+encodeURIComponent(id)+'/'+action,'POST',{});notice.textContent=action==='run'?(r.run.status==='running'?'Started. Follow it in the Command center.':(r.run.message||r.run.status)):''}
 }catch(error){notice.textContent=error.message}
 loadAutomations().catch(()=>{});
}
const syncAutomationForm=()=>{const t=$('#auto-trigger').value;$('#auto-cron-label').hidden=t!=='schedule';$('#auto-github-label').hidden=t!=='github';$('#auto-branches-label').hidden=t!=='github';$('#auto-path-label').hidden=t!=='file';const mission=$('#auto-kind').value==='mission';$$('.auto-mission').forEach(el=>{el.hidden=!mission})};
$('#auto-trigger').onchange=syncAutomationForm;$('#auto-kind').onchange=syncAutomationForm;
$('#automation-new-panel').addEventListener('toggle',async()=>{if(!$('#automation-new-panel').open)return;syncAutomationForm();const r=await api('/v1/models');if(!r.ok)return;const m=(await r.json()).models||[];if(m.length)$('#auto-model').innerHTML=m.map(x=>'<option>'+esc(x)+'</option>').join('')});
$('#automation-form').onsubmit=async e=>{e.preventDefault();const notice=$('#automations-notice'),kind=$('#auto-kind').value,text=$('#auto-text').value.trim(),trigger=$('#auto-trigger').value;
 const body={name:$('#auto-name').value.trim(),trigger:trigger==='schedule'?{kind:trigger,cron:$('#auto-cron').value.trim()}:trigger==='github'?{kind:trigger,events:[...$('#auto-github-events').selectedOptions].map(o=>o.value),branches:$('#auto-branches').value.split(',').map(b=>b.trim()).filter(Boolean)}:trigger==='file'?{kind:trigger,path:$('#auto-path').value.trim()}:{kind:trigger},maxRunsPerDay:Number($('#auto-max').value),
  action:kind==='team'?{kind,goal:text}:{kind,repository:$('#auto-repository').value.trim(),model:$('#auto-model').value,tasks:text.split(String.fromCharCode(10)).map(t=>t.trim()).filter(Boolean)}};
 try{const r=await sendJson('/v1/automations','POST',body);notice.textContent='Created.';$('#automation-new-panel').open=false;$('#automation-form').reset();
  const secret=$('#automation-secret');if(r.webhookPath){secret.hidden=false;secret.innerHTML='<h4>Webhook address</h4><p><code>'+esc(location.origin+r.webhookPath)+'</code></p>'+(r.githubSigningSecret?'<h4>GitHub signing secret</h4><p><code>'+esc(r.githubSigningSecret)+'</code></p>':'')+'<p class="hint">'+esc(r.note)+(r.githubSigningSecret?' GitHub must be able to reach this computer (Settings → Reach Atlas).':' Send a POST to it; an Idempotency-Key header makes retries safe.')+'</p>'}else secret.hidden=true}
 catch(error){notice.textContent=error.message}
 loadAutomations().catch(()=>{})};
$('#automations-refresh').onclick=()=>loadAutomations();

/* ---- Operator control: what Atlas is doing on this computer, and pause / take over / cancel ---- */
const OP_ACTIONS={running:[['pause','Pause'],['takeover','Take over'],['cancel','Cancel']],paused:[['resume','Resume'],['takeover','Take over'],['cancel','Cancel']],taken_over:[['handback','Hand back to Atlas'],['cancel','Cancel']],blocked:[['takeover','Take over'],['cancel','Cancel']],interrupted:[['takeover','Take over to check'],['cancel','Cancel']],cancelled:[['begin','Let Atlas operate again']],idle:[]};
const opAttr=v=>esc(v).replaceAll('"','&quot;');
async function loadOperator(){
 let s;try{s=(await getJson('/v1/operator')).status}catch(error){return}
 $('#operator-state').innerHTML=pill(s.state);
 const bits=[];if(s.site)bits.push(esc(s.site));if(s.currentAction)bits.push('doing '+esc(s.currentAction.type));if(s.approvalPending)bits.push('waiting for your approval');if(s.state==='running')bits.push(Math.round(s.elapsedMs/1000)+' s');
 $('#operator-line').innerHTML=s.state==='idle'?'Atlas is not operating the computer right now.':(bits.join(' · ')||esc(s.lastReason||''))+(s.state!=='running'&&s.lastActor?' · set by '+esc(s.lastActor):'')+(s.state==='blocked'&&s.lastReason?' · '+esc(s.lastReason):'');
 $('#operator-actions').innerHTML=(OP_ACTIONS[s.state]||[]).map(a=>'<button type="button" class="'+(a[0]==='cancel'?'ghost':'secondary')+'" data-op="'+a[0]+'">'+esc(a[1])+'</button>').join('');
 $('#operator-uncertain').innerHTML=(s.uncertain||[]).map(u=>'<article class="card"><p>'+esc(u.summary)+'</p><p class="hint">Atlas stopped before it could check whether this happened, so it will not do it again on a guess. Look at the computer, then say which.</p><div class="actions"><button type="button" data-ack="'+opAttr(u.id)+'" data-verdict="happened">It happened</button><button type="button" class="secondary" data-ack="'+opAttr(u.id)+'" data-verdict="did_not_happen">It did not happen</button></div></article>').join('');
 $('#operator-milestones').innerHTML=(s.milestones||[]).length?s.milestones.slice().reverse().map(m=>'<div class="meta"><span>'+esc(m.kind)+'</span><span>'+esc(m.host||'')+'</span><span>'+esc(m.risk||'')+'</span><span>'+esc(m.outcome)+'</span><time>'+when(m.at)+'</time></div>').join(''):'<p class="empty">Nothing yet.</p>';
 if(s.auditWarning)$('#operator-notice').textContent=s.auditWarning;
}
$('#operator-panel').onclick=async e=>{const b=e.target.closest('button');if(!b)return;const notice=$('#operator-notice');notice.textContent='';
 try{
  if(b.dataset.op){if(b.dataset.op==='cancel'&&!confirm('Cancel what Atlas is doing on the computer? It stays stopped until you let it operate again.'))return;await sendJson('/v1/operator/'+b.dataset.op,'POST',{})}
  else if(b.dataset.ack)await sendJson('/v1/operator/intents/'+encodeURIComponent(b.dataset.ack)+'/acknowledge','POST',{verdict:b.dataset.verdict});
 }catch(error){notice.textContent=error.message}
 loadOperator().catch(()=>{})};
setInterval(()=>{if(currentView==='computer'&&isUnlocked()&&!document.hidden)loadOperator().catch(()=>{})},2000);

/* ---- Home ---- */
async function loadBadge(){
 const {approvals}=await getJson('/v1/approvals');const pending=approvals.filter(a=>a.status==='pending');
 const badge=$('#approvals-badge');badge.hidden=!pending.length;badge.textContent=String(pending.length);
 return pending;
}
async function loadHome(){
 const [pending,team,health,executors]=await Promise.all([loadBadge().catch(()=>[]),getJson('/v1/team/missions').catch(()=>({missions:[]})),fetch('/health').then(r=>r.json()).catch(()=>null),getJson('/v1/executors').catch(()=>({executors:[]}))]);
 $('#home-attention').innerHTML=pending.length?pending.slice(0,4).map(a=>'<a class="card" href="#/approvals"><h4>'+esc(a.summary)+'</h4><div class="meta"><span>'+esc(a.capability)+'</span><time>'+when(a.createdAt)+'</time></div></a>').join(''):'<p class="empty">Nothing is waiting for you.</p>';
 const running=team.missions.filter(m=>!['completed','failed','cancelled'].includes(m.status));
 $('#home-running').innerHTML=running.length?running.slice(0,4).map(m=>'<a class="card" href="#/missions" data-mission-link="'+esc(m.id)+'"><div class="task-top"><h4>'+esc(m.goal)+'</h4>'+pill(m.status)+'</div><progress max="'+m.steps.total+'" value="'+m.steps.completed+'"></progress><div class="meta"><span>'+m.steps.completed+' of '+m.steps.total+' steps</span><span>'+esc(m.agents.join(', '))+'</span></div></a>').join(''):'<p class="empty">No missions are running.</p>';
 $$('[data-mission-link]').forEach(a=>a.addEventListener('click',()=>{openMissionId=a.dataset.missionLink}));
 getJson('/v1/identity').then(i=>{const o=$('#home-owner');if(o)o.textContent=i.role==='owner'&&i.account?'Signed in as '+i.account.user+' on '+i.account.host+' (this computer\\'s account)':i.role==='device'?'Paired device: '+(i.device.name||'unnamed'):''}).catch(()=>{});
 $('#home-machine').innerHTML='<dl class="kv"><dt>Model</dt><dd>'+esc(health?.model||'unavailable')+'</dd><dt>Runs on</dt><dd>'+esc((executors.executors||[]).join(', ')||'none')+'</dd><dt>Mode</dt><dd>'+esc(health?.license?.mode||'community')+'</dd></dl>';
 /* Say a model is ready only after finding one. */
 getJson('/v1/models/health').then(h=>{
  const models=(h.servers||[]).flatMap(x=>x.models||[]);
  $('#health').textContent=models.length?models.length+' model'+(models.length===1?'':'s')+' available':'No model server found';
  $('#health-dot').className='dot '+(models.length?'ok':'bad');
 }).catch(()=>{$('#health-dot').className='dot '+(health?.status==='ok'?'ok':'bad')});
}

/* ---- Missions (agent organization) ---- */
async function startGoal(goal,noticeEl){
 noticeEl.textContent='Planning with the Product Executive…';
 try{
  const body=await sendJson('/v1/team/missions','POST',{goal});
  noticeEl.textContent='Planned '+body.plan.steps.length+' step'+(body.plan.steps.length===1?'':'s')+'. The team has started.';
  openMissionId=body.mission.id;return body;
 }catch(error){noticeEl.textContent=error.message+(error.unblock?' '+error.unblock:'');return null}
}
$('#goal-form').onsubmit=async e=>{e.preventDefault();const goal=$('#goal-text').value.trim();if(!goal)return;const started=await startGoal(goal,$('#goal-notice'));if(started){$('#goal-text').value='';loadTeam()}};
$('#to-team').onclick=async()=>{const goal=$('#turn-text').value.trim();if(!goal){runStatus.textContent='Write the goal in the message box first.';return}const started=await startGoal(goal,runStatus);if(started){$('#turn-text').value='';location.hash='#/missions'}};
$('#team-refresh').onclick=()=>loadTeam();
async function loadTeam(){
 const box=$('#team-missions');
 try{
  const {missions}=await getJson('/v1/team/missions');
  box.innerHTML=missions.length?missions.slice().reverse().map(m=>'<button type="button" class="card clickable'+(m.id===openMissionId?' selected':'')+'" data-open="'+esc(m.id)+'"><div class="task-top"><h4>'+esc(m.goal)+'</h4>'+pill(missionState(m))+'</div><progress max="'+m.steps.total+'" value="'+m.steps.completed+'"></progress><div class="meta"><span>'+m.steps.completed+'/'+m.steps.total+' steps verified</span>'+(m.steps.failed?'<span>'+m.steps.failed+' failed</span>':'')+'<span>'+m.usage.toolCalls+' tool calls</span><time>'+when(m.createdAt)+'</time></div></button>').join(''):'<p class="empty">No missions yet. Describe a goal above and the team will plan it.</p>';
  box.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{openMissionId=b.dataset.open;shownMission='';loadTeam()});
  /* Re-render the open mission only while it can still change, so reading it is not interrupted. */
  const open=missions.find(m=>m.id===openMissionId);
  const stamp=open?open.id+open.status+open.taskStatus+open.steps.completed+open.steps.failed+open.usage.toolCalls:'';
  if(open&&stamp!==shownMission){shownMission=stamp;await openMission(openMissionId)}
 }catch(error){box.innerHTML=problem(error)}
}
async function openMission(id){
 const panel=$('#mission-detail');
 try{
  const {mission:m}=await getJson('/v1/team/missions/'+encodeURIComponent(id));
  const live=!['completed','failed','cancelled'].includes(m.status);
  const controls=live?'<div class="actions">'+(m.status==='paused'||m.status==='interrupted'?'<button class="secondary" data-team-action="resume">Resume</button>':'<button class="secondary" data-team-action="pause">Pause</button>')+'<button class="danger" data-team-action="cancel">Cancel</button></div>':'';
  const titles=new Map(m.steps.map(x=>[x.id,x.title]));
  const steps='<ol class="steps">'+m.steps.map(s=>'<li class="'+esc(s.state)+'"><div class="task-top"><strong>'+esc(s.title)+'</strong>'+pill(s.verified===true?'verified':s.state)+'</div><div class="meta"><span>'+esc(s.agent)+'</span>'+(s.dependsOn?.length?'<span>after '+esc(s.dependsOn.map(d=>titles.get(d)||d).join(', '))+'</span>':'')+'<span>'+(s.usage?.toolCalls??0)+' tool calls</span></div><p class="hint">Done when: '+esc(s.doneWhen)+'</p>'+(s.summary?'<p>'+esc(s.summary)+'</p>':'')+'</li>').join('')+'</ol>';
  const calls=m.toolCalls.length?'<table class="table"><thead><tr><th>Agent</th><th>Tool</th><th>Result</th></tr></thead><tbody>'+m.toolCalls.map(c=>'<tr><td>'+esc(c.agent)+'</td><td><code>'+esc(c.tool)+'</code></td><td>'+pill(c.status)+(c.error?.message?'<div class="hint">'+esc(c.error.message)+'</div>':'')+'</td></tr>').join('')+'</tbody></table>':'<p class="empty">No tools used yet.</p>';
  const artifacts=m.artifacts.length?m.artifacts.map(a=>'<details class="card"><summary><strong>'+esc(a.step||a.kind)+'</strong> · '+esc(a.agent||'')+' '+pill(a.verification)+'</summary>'+(a.report?'<p>'+esc(a.report)+'</p>':'')+(a.evidence||[]).map(ev=>'<p class="hint">Check: '+esc(ev.check||'')+' — '+esc(ev.reason||'')+'</p>').join('')+'</details>').join(''):'<p class="empty">No reports yet.</p>';
  const handoffs=m.messages.length?'<table class="table"><thead><tr><th>Message</th><th>From</th><th>To</th></tr></thead><tbody>'+m.messages.map(x=>'<tr><td>'+esc(x.type.replaceAll('_',' ').toLowerCase())+'</td><td>'+esc(x.from)+'</td><td>'+esc(x.to)+'</td></tr>').join('')+'</tbody></table>':'<p class="empty">No hand-offs yet.</p>';
  panel.innerHTML='<div class="task-top"><h3>'+esc(m.goal)+'</h3>'+pill(missionState(m))+'</div><div class="meta"><span>'+m.usage.toolCalls+' tool calls</span><span>'+(m.usage.inputTokens+m.usage.outputTokens).toLocaleString()+' tokens</span><span>'+esc(m.agents.join(', '))+'</span></div>'+controls+'<h3>Plan</h3>'+steps+'<h3>Reports and checks</h3><div class="list">'+artifacts+'</div><h3>Tools used</h3>'+calls+'<details class="more"><summary>Hand-offs between agents</summary>'+handoffs+'</details>';
  panel.querySelectorAll('[data-team-action]').forEach(b=>b.onclick=async()=>{
   if(b.dataset.teamAction==='cancel'&&!confirm('Cancel this mission? Steps in progress stop at their next checkpoint.'))return;
   try{await sendJson('/v1/team/missions/'+encodeURIComponent(id)+'/'+b.dataset.teamAction,'POST',{});setNotice('Mission '+b.dataset.teamAction+' requested.')}catch(error){setNotice(error.message)}
   shownMission='';loadTeam();
  });
 }catch(error){panel.innerHTML=problem(error)}
}

/* ---- Agent families ---- */
async function loadFamilies(){
 const box=$('#org-tree');
 try{
  const [{organization},roster]=await Promise.all([getJson('/v1/innovation/organization'),getJson('/v1/team/roster').catch(()=>({agents:[]}))]);
  if(!organization?.tree){box.innerHTML='<p class="empty">The organization has not been set up yet. Restart Atlas to seed it.</p>';return}
  const tools=new Map(roster.agents.map(a=>[a.id,a.tools]));
  const node=a=>'<li><span class="node"><strong>'+esc(a.name||a.role)+'</strong><small>'+esc(a.family.replaceAll('_',' '))+' · '+esc(a.state)+(tools.get(a.id)?.length?' · '+tools.get(a.id).length+' tools':'')+'</small></span>'+(a.children?.length?'<ul>'+a.children.map(node).join('')+'</ul>':'')+'</li>';
  box.innerHTML='<ul>'+node(organization.tree)+'</ul>'+(organization.peers?.length?'<p class="hint">Peer organizations commissioned by the executives: '+esc(organization.peers.map(p=>p.name||p.family).join(', '))+'.</p>':'');
 }catch(error){box.innerHTML=problem(error)}
}

/* ---- Computer ---- */
const GROUPS=[['browser.','Browser','Open pages, read them and fill forms. Pages on private or local network addresses are refused. Needs the Atlas companion browser on this machine.'],['desktop.','Desktop','See the screen and use the mouse and keyboard. Needs a supported desktop session on this machine.'],['terminal.','Terminal','Run allow-listed commands in a separate workspace. There is no shell.'],['repository.','Code','Read and change code in isolated copies.'],['filesystem.','Files','Files inside the Atlas workspace only.'],['communications.','Messages','Draft and send messages. No mail service is connected in this build, so sending refuses with a reason.'],['workflow.','Workflows','Scheduled and chained work.'],['infrastructure.','Infrastructure','Hosting and DNS providers you have connected.'],['mcp.','Tool servers','Tools from MCP servers you configured.']];
async function setPolicy(capability,decision){
 try{await sendJson('/v1/policies','PUT',{capability,decision});setNotice(capability+' is now '+decision+'.')}catch(error){setNotice(error.message)}
}
const policySelect=(capability,decision)=>'<select data-policy="'+esc(capability)+'" aria-label="Policy for '+esc(capability)+'">'+['allow','ask','deny'].map(d=>'<option'+(d===decision?' selected':'')+'>'+d+'</option>').join('')+'</select>';
function bindPolicies(root,after){root.querySelectorAll('[data-policy]').forEach(s=>s.onchange=async()=>{await setPolicy(s.dataset.policy,s.value);after()})}
async function loadComputer(){
 loadOperator().catch(()=>{});
 const box=$('#computer-tools');
 try{
  const [{tools},{suggestions}]=await Promise.all([getJson('/v1/tools'),getJson('/v1/autonomy').catch(()=>({suggestions:[]}))]);
  if(!tools.length){box.innerHTML='<p class="empty">No tools are registered in this process.</p>';return}
  /* Precedent (Track B8): suggestions only; nothing changes until the owner accepts one. */
  const suggested=suggestions.length?'<section class="panel group"><h3>Atlas could do more on its own</h3>'+suggestions.map(x=>'<div class="policy"><span>'+esc(x.reason)+'</span><button type="button" class="secondary" data-relax="'+esc(x.capability)+'">Let Atlas do this without asking</button></div>').join('')+'</section>':'';
  const used=new Set;
  const html=GROUPS.map(([prefix,title,blurb])=>{
   const group=tools.filter(t=>t.name.startsWith(prefix));group.forEach(t=>used.add(t.name));
   if(!group.length)return '';
   const caps=[...new Map(group.map(t=>[t.capability,t.decision])).entries()];
   return '<section class="panel group"><h3>'+esc(title)+'</h3><p class="hint">'+esc(blurb)+'</p>'+caps.map(([cap,decision])=>'<div class="policy"><span><code>'+esc(cap)+'</code> '+pill(decision)+'</span>'+policySelect(cap,decision)+'</div>').join('')+'<details class="more"><summary>'+group.length+' tool'+(group.length===1?'':'s')+'</summary>'+group.map(t=>'<div class="tool"><code>'+esc(t.name)+'</code><span class="chip">'+esc(t.risk)+(t.requiresApproval?' · always asks':'')+'</span>'+(t.autonomy?'<span class="chip" title="'+esc(t.autonomy.reasons.join('; '))+'">level '+t.autonomy.level+': '+esc(t.autonomy.label)+'</span>':'')+'<p>'+esc(t.description)+'</p></div>').join('')+'</details></section>';
  }).join('');
  const other=tools.filter(t=>!used.has(t.name));
  box.innerHTML=suggested+html+(other.length?'<section class="panel group"><h3>Other</h3>'+other.map(t=>'<div class="tool"><code>'+esc(t.name)+'</code>'+pill(t.decision)+'<p>'+esc(t.description)+'</p></div>').join('')+'</section>':'');
  bindPolicies(box,loadComputer);
  box.querySelectorAll('[data-relax]').forEach(b=>b.onclick=async()=>{await setPolicy(b.dataset.relax,'allow');loadComputer()});
 }catch(error){box.innerHTML=problem(error)}
}

/* ---- Knowledge ---- */
$('#knowledge-form').onsubmit=e=>{e.preventDefault();loadKnowledge()};
async function loadKnowledge(){
 const box=$('#knowledge-list');const query=$('#knowledge-q').value.trim();
 try{
  const {entries}=await getJson('/v1/knowledge?q='+encodeURIComponent(query)+'&limit=50');
  box.innerHTML=entries.length?entries.map(e=>'<article class="card"><div class="task-top"><h4>'+esc(String(e.content).slice(0,140))+'</h4>'+pill(e.kind)+'</div>'+(String(e.content).length>140?'<p>'+esc(e.content)+'</p>':'')+'<div class="meta"><span>'+esc(e.scope)+': '+esc(e.scope_ref)+'</span><span>from '+esc(e.provenance?.source||'unknown')+'</span>'+(e.provenance?.sourceRefs?.length?'<span>'+esc(e.provenance.sourceRefs.slice(0,3).join(', '))+'</span>':'')+'<time>'+when(e.created_at)+'</time>'+(e.redacted?'<span>secrets removed</span>':'')+'</div><div class="actions"><button type="button" class="ghost" data-history="'+esc(e.id)+'">History</button><button type="button" class="danger" data-forget="'+esc(e.id)+'">Delete</button></div><div data-history-box="'+esc(e.id)+'"></div></article>').join(''):'<p class="empty">'+(query?'Nothing matches that search.':'Atlas has not remembered anything yet. Verified mission steps are saved here.')+'</p>';
  box.querySelectorAll('[data-forget]').forEach(b=>b.onclick=async()=>{
   if(!confirm('Delete this entry and every earlier version of it? This cannot be undone.'))return;
   try{await getJson('/v1/knowledge/'+encodeURIComponent(b.dataset.forget),{method:'DELETE'});setNotice('Deleted.')}catch(error){setNotice(error.message)}
   loadKnowledge();
  });
  box.querySelectorAll('[data-history]').forEach(b=>b.onclick=async()=>{
   const target=box.querySelector('[data-history-box="'+CSS.escape(b.dataset.history)+'"]');
   try{const {versions}=await getJson('/v1/knowledge/'+encodeURIComponent(b.dataset.history)+'/history');target.innerHTML=versions.map(v=>'<p class="hint">v'+v.version+' · '+when(v.created_at||v.deleted_at)+(v.deleted?' · deleted':' · '+esc(String(v.content).slice(0,200)))+'</p>').join('')}catch(error){target.innerHTML=problem(error)}
  });
 }catch(error){box.innerHTML=problem(error)}
}

/* ---- Connections ---- */
async function loadConnections(){
 const modelsBox=$('#models-health'),mcpBox=$('#mcp-list');
 getJson('/v1/models/health').then(h=>{
  const servers=(h.servers||[]).map(s=>'<div class="card"><div class="task-top"><h4>'+esc(s.kind)+' on '+esc(s.location)+'</h4>'+pill('connected')+'</div><p>'+esc((s.models||[]).map(m=>m.name||m).join(', ')||'No models installed.')+'</p></div>').join('');
  const routes=(h.routes||[]).length?'<table class="table"><thead><tr><th>Work</th><th>Model</th><th>Where</th></tr></thead><tbody>'+h.routes.map(r=>'<tr><td>'+esc(r.task)+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.location)+'</td></tr>').join('')+'</tbody></table>':'';
  const recs=Object.entries(h.recommendations||{}).map(([task,r])=>'<p class="hint"><strong>'+esc(task)+':</strong> '+esc(r.reason)+'</p>').join('');
  const hw=h.hardware?'<p class="hint">'+h.hardware.cpuCount+' CPU cores · '+h.hardware.totalMemoryGiB+' GiB memory'+(h.hardware.gpus?.length?' · '+esc(h.hardware.gpus.map(g=>g.name).join(', ')):'')+'</p>':'';
  modelsBox.innerHTML=(servers||'<div class="error"><strong>No model server found on this computer.</strong><p>Install Ollama and pull a model, or set ATLAS_MODEL_ENDPOINT to an OpenAI-compatible server.</p></div>')+routes+hw+recs;
 }).catch(error=>{modelsBox.innerHTML=problem(error)});
 try{
  const [{mcp},{tools}]=await Promise.all([getJson('/v1/connections'),getJson('/v1/tools').catch(()=>({tools:[]}))]);
  const decisions=new Map(tools.map(t=>[t.capability,t.decision]));
  mcpBox.innerHTML=mcp.length?mcp.map(s=>{const cap='mcp.'+s.id,decision=decisions.get(cap)||'deny';return '<div class="card"><div class="task-top"><h4>'+esc(s.id)+'</h4>'+pill(s.status)+'</div>'+(s.message?'<p>'+esc(s.message)+'</p>':'')+(s.tools?'<p>'+(s.tools.length?esc(s.tools.join(', ')):'No allowed tools.')+'</p>':'')+(s.flagged?.length?'<p class="hint">Blocked because their descriptions look like instructions: '+esc(s.flagged.join(', '))+'</p>':'')+(s.status==='connected'?'<div class="policy"><span>Agents may use these tools</span>'+policySelect(cap,decision)+'</div>':'')+'</div>'}).join(''):'<p class="empty">No tool servers configured. Set ATLAS_MCP_SERVERS and restart Atlas to add one.</p>';
  bindPolicies(mcpBox,loadConnections);
 }catch(error){mcpBox.innerHTML=problem(error)}
}

syncLock();
show(viewFromHash());
setInterval(()=>{if(isUnlocked()&&!document.hidden&&['home','missions','improve','models','build'].includes(currentView))refreshView()},5000);
`;
