export const WORKFORCE_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas Workforce</title><link rel="stylesheet" href="/app.css"></head>
<body><main><header><div><p class="eyebrow">WORKFORCE</p><h1>Atlas Workforce</h1></div><nav aria-label="Local navigation"><a href="/">Control plane</a> · <a href="/platform">Task evidence</a></nav></header>
<section class="panel"><h2>Owner access</h2><form id="unlock"><label>Owner token<input id="token" type="password" autocomplete="off" required></label><button>Unlock workforce</button><button type="button" id="lock" class="secondary" disabled>Lock</button></form><p id="notice" role="status" aria-live="polite">Owner access is required. This tab keeps the token in memory only.</p></section>
<section id="workspace" hidden>
<section class="panel"><h2>Persistent agents</h2><p id="repository"></p><ul id="agents"></ul><p>Plans assign existing read-only repository tools and bounded local inference. Completed runs mean stored schema and tool-record checks passed; they do not establish business outcomes.</p></section>
<section class="panel"><h2>Explicit execution plan</h2><p>Review the JSON before starting. The example reads README.md from the configured repository. No plan runs automatically after restart.</p><form id="create"><label>Plan JSON<textarea id="plan" rows="14" required maxlength="60000" spellcheck="false"></textarea></label><button id="submit">Run plan</button></form></section>
<section class="panel"><div class="section-title"><h2>Saved runs</h2><button type="button" id="refresh" class="secondary">Refresh runs</button></div><div id="runs" class="tasks"></div></section>
<section class="panel" id="detail" hidden><h2>Selected run</h2><p id="objective"></p><p id="status"></p><div id="steps" class="tasks"></div><p><a id="evidence" href="/platform">Open task evidence</a></p><button type="button" id="resume">Resume interrupted run</button><button type="button" id="cancel" class="secondary">Cancel run</button><p>Resume continues saved work through existing receipts. Cancellation allows an active tool to reach its existing timeout; late results cannot complete a cancelled run.</p></section>
</section></main><script type="module" src="/workforce.js"></script></body></html>`;

export const WORKFORCE_UI_JS = String.raw`
const $ = id => document.getElementById(id);
let token = '', epoch = 0, selected = null, busy = false, refreshId = 0, canCreate = true;
const text = (id, value) => { $(id).textContent = String(value ?? ''); };
function notice(message) { text('notice', message); }
function controls() {
  $('submit').disabled = busy || !canCreate;
  $('resume').disabled = busy;
  $('cancel').disabled = busy;
}
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'The owner token is required. Unlock this tab again.' : 'Workforce request failed. Refresh saved runs before retrying.');
  return value;
}
function lock() {
  epoch++; refreshId++; token = ''; selected = null; busy = false; canCreate = true;
  $('token').value = ''; $('workspace').hidden = true; $('detail').hidden = true;
  $('lock').disabled = true; $('runs').replaceChildren(); $('agents').replaceChildren();
  $('plan').value = ''; controls(); notice('Locked. Owner access is required.');
}
function showRun(run) {
  $('detail').hidden = false;
  text('objective', run.objective); text('status', 'Status: ' + run.status + ' · ' + run.taskId);
  const steps = (run.steps || []).map((step, index) => {
    const entry = document.createElement('p');
    entry.textContent = 'Assignment ' + (index + 1) + ': ' + (step.artifacts || []).length + ' stored artifacts';
    return entry;
  });
  $('steps').replaceChildren(...steps);
  $('resume').hidden = run.status !== 'interrupted';
  $('cancel').hidden = ['completed', 'failed', 'cancelled'].includes(run.status);
  $('evidence').href = '/platform';
}
async function refresh({ acknowledgeUncertain = false } = {}) {
  if (!token || busy) return;
  const current = epoch, requestId = ++refreshId, taskId = selected;
  try {
    const [listing, detail] = await Promise.all([request('/v1/workforce/runs'), taskId ? request('/v1/workforce/runs/' + encodeURIComponent(taskId)) : null]);
    if (current !== epoch || requestId !== refreshId || busy) return;
    $('runs').replaceChildren(...listing.runs.map(run => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
      button.textContent = run.objective + ' · ' + run.status + ' · ' + run.completedSteps + '/' + run.stepCount + ' checked assignments';
      button.addEventListener('click', () => { selected = run.taskId; void refresh(); });
      return button;
    }));
    if (!listing.runs.length) { const empty = document.createElement('p'); empty.textContent = 'No saved workforce runs.'; $('runs').append(empty); }
    if (detail && selected === taskId) showRun(detail.run);
    if (acknowledgeUncertain) canCreate = true;
    controls();
  } catch { if (current === epoch && requestId === refreshId) notice('Could not refresh workforce. Check owner access and the local daemon.'); }
}
$('unlock').addEventListener('submit', async event => {
  event.preventDefault(); const candidate = $('token').value.trim();
  if (!candidate) return;
  epoch++; const current = epoch; token = candidate; selected = null; $('workspace').hidden = true; $('detail').hidden = true;
  $('token').value = ''; busy = false;
  try {
    const overview = await request('/v1/workforce');
    if (current !== epoch) return;
    text('repository', 'Repository: ' + overview.repository);
    $('agents').replaceChildren(...overview.agentDetails.map(agent => { const item = document.createElement('li'); item.textContent = agent.name + ' · ' + agent.state; return item; }));
    $('plan').value = JSON.stringify({ ownerAgentId: overview.rootId, reviewerAgentId: overview.agents['Quality Reviewer'],
      objective: 'Inspect README and preserve reviewed evidence', constraints: { privacy: 'local_only' }, budget: { toolCalls: 4, wallTimeMs: 30000 },
      steps: [{ agentId: overview.agents['Engineering Worker'],
        calls: [{ tool: 'repository.read', input: { path: 'README.md', lineCount: 20 }, outputSchema: { type: 'string', minLength: 1 } }] }] }, null, 2);
    $('workspace').hidden = false; $('lock').disabled = false; canCreate = true; controls();
    notice('Unlocked. Review the plan before starting it.'); await refresh();
  } catch { if (current === epoch) { lock(); notice('Could not unlock. Use the local owner token and check the daemon.'); } }
});
$('create').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !token || !canCreate) return;
  let plan;
  try { plan = JSON.parse($('plan').value); if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error(); }
  catch { notice('Plan must be a JSON object. Nothing was submitted.'); return; }
  const current = epoch; busy = true; controls();
  try {
    const intake = await request('/v1/workforce/runs', 'POST', plan);
    if (current !== epoch) return;
    if (!/^tsk_[0-9a-f]{32}$/.test(intake.taskId || '')) throw new Error('Missing intake receipt');
    selected = intake.taskId; notice('Plan accepted. Execution and review status appear below.');
  } catch {
    if (current === epoch) { canCreate = false; notice('Plan acceptance could not be confirmed. Refresh saved runs before submitting again.'); }
  } finally { if (current === epoch) { busy = false; controls(); if (canCreate) await refresh(); } }
});
async function action(kind) {
  if (!token || busy || !selected) return;
  const current = epoch, taskId = selected; busy = true; controls();
  try { await request('/v1/workforce/runs/' + encodeURIComponent(taskId) + '/' + kind, 'POST', {}); if (current === epoch) notice(kind === 'cancel' ? 'Cancellation recorded. Refreshing the saved state.' : 'Resume accepted. Refreshing the saved state.'); }
  catch { if (current === epoch) notice('The operation could not be confirmed. Refresh saved state before retrying.'); }
  finally { if (current === epoch) { busy = false; controls(); await refresh(); } }
}
$('resume').addEventListener('click', () => { void action('resume'); });
$('cancel').addEventListener('click', () => { void action('cancel'); });
$('refresh').addEventListener('click', () => { void refresh({ acknowledgeUncertain: true }); });
$('lock').addEventListener('click', lock);
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
window.addEventListener('pagehide', lock);
`;
