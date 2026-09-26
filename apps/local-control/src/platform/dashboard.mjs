/**
 * Minimal platform dashboard (blueprint §21 item 6): a task's status, its
 * state transitions, every tool call with its policy decision, its artifacts
 * with verification evidence, and its correlated audit events.
 *
 * These two data routes are read-only on purpose. Creating, authorizing,
 * cancelling, approving and stopping are separate, owner-only operations in
 * api-routes.mjs; the command-center page calls those routes explicitly, so a
 * rendering bug in a read path can never become an action.
 *
 * The local daemon has one owner, so everything it runs lives in one tenant.
 * The tenant is still passed on every read so that the same routes serve a
 * multi-tenant store unchanged once identity carries a tenant.
 */
export const LOCAL_TENANT_ID = "local";

const TASK_ID = "tsk_[0-9a-f]{32}";
const MAX_LIST = 200;

export function createPlatformRoutes({ store, tenantFor = () => LOCAL_TENANT_ID }) {
  if (!store) throw new TypeError("store is required.");

  /** Pages carry no data, so they are served before authentication. */
  function handlePage(request, response) {
    if (request.method !== "GET") return false;
    if (request.url === "/platform") return sendText(response, 200, "text/html; charset=utf-8", PLATFORM_UI_HTML);
    if (request.url === "/platform.js") return sendText(response, 200, "text/javascript; charset=utf-8", PLATFORM_UI_JS);
    if (request.url === "/platform.css") return sendText(response, 200, "text/css; charset=utf-8", PLATFORM_UI_CSS);
    return false;
  }

  /** Data routes run only after the caller's token was accepted. */
  function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/platform/")) return false;
    if (request.method !== "GET") return send(response, 405, { message: "The platform dashboard is read-only." });
    const tenantId = tenantFor(identity);

    if (url.pathname === "/v1/platform/tasks") {
      const status = url.searchParams.get("status") || undefined;
      const limit = Math.min(MAX_LIST, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      try {
        const tasks = store.listTasks(tenantId, { status, limit }).map((task) => ({
          ...summarize(task),
          toolCalls: store.getToolCalls(tenantId, task.id).length,
        }));
        return send(response, 200, { tasks });
      } catch (error) {
        return send(response, 400, { message: error instanceof Error ? error.message : "Invalid query." });
      }
    }

    const match = new RegExp(`^/v1/platform/tasks/(${TASK_ID})$`, "u").exec(url.pathname);
    if (match) {
      const task = store.getTask(tenantId, match[1]);
      if (!task) return send(response, 404, { message: "Task not found." });
      return send(response, 200, {
        task,
        transitions: store.listTransitions(tenantId, task.id),
        toolCalls: store.getToolCalls(tenantId, task.id).map((call) => ({
          ...call,
          decision: call.policyDecisionId ? store.getPolicyDecision(tenantId, call.policyDecisionId) : null,
        })),
        approvals: store.listApprovals(tenantId, { taskId: task.id }),
        artifacts: store.listArtifacts(tenantId, { taskId: task.id }).map(withoutBulkyContent),
        events: store.listEvents(tenantId, { taskId: task.id, limit: 500 }),
      });
    }
    return send(response, 404, { message: "Route not found." });
  }

  return { handlePage, handle };
}

function summarize(task) {
  const { id, objective, status, correlationId, agentId, usage, budget, createdAt, updatedAt } = task;
  return { id, objective, status, correlationId, agentId, usage, budget, createdAt, updatedAt };
}

/** Screenshots and large payloads stay in the store; the view shows their digest. */
function withoutBulkyContent(artifact) {
  const size = JSON.stringify(artifact.content ?? null).length;
  return size > 16 * 1024 ? { ...artifact, content: { omitted: true, bytes: size } } : artifact;
}

function send(response, status, value) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(value));
  return true;
}

function sendText(response, status, contentType, value) {
  response.setHeader("content-type", contentType);
  response.writeHead(status);
  response.end(value);
  return true;
}


/*
 * The command center page. Everything it shows comes from the authenticated
 * /v1/platform/ routes; the page itself carries no data and no inline script
 * or style, so the daemon's CSP (script-src 'self'; style-src 'self') holds.
 */
export const PLATFORM_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas Tasks · Command Center</title><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/platform.css"></head>
<body class="cc"><main>
<header class="cc-header"><div><p class="eyebrow">COMMAND CENTER</p><h1>Atlas Tasks</h1></div>
<div class="cc-header-actions"><span class="role" id="role">locked</span><a href="/">Control plane</a><button type="button" class="danger" id="emergency-stop" data-write>Emergency stop</button></div></header>
<p id="notice" class="notice" role="status" aria-live="polite"></p>
<section class="panel" id="unlock"><h2>Local access</h2><label>Access token<input id="token" type="password" autocomplete="off" placeholder="Paste the token printed at first launch"></label><button id="save-token">Unlock this tab</button></section>
<div class="cc-grid">
<div class="cc-main">
<section class="panel" data-write><h2>New objective</h2>
<form id="composer"><label>Objective<textarea id="objective" required maxlength="8000" placeholder="What should Atlas accomplish?"></textarea></label>
<label>Success criteria <span class="hint">one per line</span><textarea id="criteria" required placeholder="The report lists every open invoice"></textarea></label>
<div class="cc-budget"><label>Tool calls<input id="budget-calls" type="number" min="0" step="1" value="50"></label>
<label>Wall time (min)<input id="budget-minutes" type="number" min="0" step="1" value="30"></label>
<label>Cost cap (USD)<input id="budget-usd" type="number" min="0" step="0.01" value="1.00"></label></div>
<button type="submit">Propose task</button> <span class="hint">Proposed tasks do nothing until you authorize and queue them.</span></form></section>
<section><div class="section-title"><h2>Tasks</h2><div class="cc-inline"><select id="filter" aria-label="Filter tasks by state"><option value="">All states</option><option value="active">Active</option><option>proposed</option><option>authorized</option><option>queued</option><option>running</option><option>waiting_for_approval</option><option>waiting_for_dependency</option><option>verifying</option><option>completed</option><option>failed</option><option>cancelled</option></select><button class="secondary" id="refresh">Refresh</button></div></div>
<div id="tasks" class="tasks"><p class="empty">Unlock this tab to load tasks.</p></div></section>
<section class="panel" id="detail" hidden><div class="section-title"><h2 id="detail-title">Task</h2><span id="detail-status"></span></div>
<p class="hint" id="detail-meta"></p><p class="blocked" id="detail-blocked" hidden></p>
<h3>Transitions</h3><div id="transitions" class="tasks"></div>
<h3>Tool calls</h3><div id="calls" class="tasks"></div>
<h3>Approvals</h3><div id="approvals" class="tasks"></div>
<h3>Artifacts</h3><div id="artifacts" class="tasks"></div>
<h3>Events</h3><div id="events" class="tasks"></div></section>
</div>
<aside class="cc-side">
<section class="panel"><div class="section-title"><h2>Approvals inbox</h2><span class="count" id="approval-count">0</span></div><div id="inbox" class="tasks"><p class="empty">Nothing waiting.</p></div></section>
<section class="panel"><h2>Cost and usage</h2><div id="costs"><p class="empty">No usage yet.</p></div></section>
<section class="panel"><h2>Worker health</h2><div id="workers"><p class="empty">Unknown.</p></div></section>
</aside>
</div>
<section class="panel"><div class="section-title"><h2>Agent family</h2><span class="hint" id="family-counts"></span></div><div id="family" class="family"><p class="empty">No agents.</p></div></section>
<section class="panel"><h2>Memory inspector</h2>
<form id="memory-search" class="cc-inline"><input id="memory-query" type="search" maxlength="500" placeholder="Search memory"><button type="submit" class="secondary">Search</button></form>
<form id="memory-add" class="cc-inline" data-write><input id="memory-content" maxlength="16384" placeholder="Record an observation"><button type="submit" class="secondary">Remember</button></form>
<div id="memory" class="tasks"><p class="empty">No memory entries.</p></div></section>
</main><script type="module" src="/platform.js"></script></body></html>`;

export const PLATFORM_UI_CSS = `body.cc main{width:min(1240px,calc(100% - 32px))}
.cc-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.cc-header-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:14px}
.cc-header-actions a{color:#d8ff8f}
.role{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid #405247;border-radius:999px;padding:4px 10px;color:#bfd0c3}
button.danger{background:#ff6b5e;color:#200806}
button.small{padding:6px 11px;font-size:.82rem}
button:disabled{opacity:.45;cursor:not-allowed}
.notice{min-height:1.2em;color:#d8ff8f;margin:0 0 12px}.notice.error{color:#ffb0a7}
.cc-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start}
.cc-side .panel{margin-bottom:18px}
.cc-inline{display:flex;gap:10px;align-items:center;margin-bottom:12px}.cc-inline input,.cc-inline select{flex:1;min-width:0}
.cc-budget{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.state{display:inline-block;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;border-radius:999px;padding:3px 9px;white-space:nowrap;border:1px solid currentColor}
.state-proposed{color:#c9b8ff}.state-authorized,.state-queued{color:#8fd3ff}
.state-running{color:#14200f;background:#d8ff8f;border-color:#d8ff8f}
.state-waiting_for_approval,.state-waiting_for_dependency{color:#ffd27a}
.state-verifying{color:#7af0e0}.state-completed{color:#9be89b}
.state-failed{color:#200806;background:#ff8f84;border-color:#ff8f84}
.state-cancelled,.state-archived,.state-retired,.state-rejected{color:#91a397}
.state-idle{color:#bfd0c3}
.task .meta{font-size:.78rem;color:#9aafa0;margin:6px 0 0}
.task .row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.blocked{color:#ffd27a;font-size:.88rem;margin:8px 0 0}
.count{background:#d8ff8f;color:#14200f;border-radius:999px;padding:2px 9px;font-weight:750;font-size:.8rem}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:12px}
.stat{border:1px solid #33443a;border-radius:12px;padding:10px}.stat b{display:block;font-size:1.25rem}.stat span{font-size:.72rem;color:#9aafa0;letter-spacing:.08em;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{text-align:left;padding:6px 4px;border-top:1px solid #29372f;vertical-align:top}th{color:#9aafa0;font-weight:600}
.health{display:grid;gap:8px}.health div{display:flex;justify-content:space-between;gap:10px;border-top:1px solid #29372f;padding-top:8px}.ok{color:#9be89b}.bad{color:#ffb0a7}
.family ul{list-style:none;margin:0;padding-left:18px;border-left:1px dashed #33443a}.family>ul{padding-left:0;border-left:0}
.family li{margin:8px 0}.agent{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.agent b{font-size:.95rem}
.tag{font-size:.72rem;border-radius:6px;padding:2px 7px;background:#26352b;color:#dfe9e1}
.perm{font-family:ui-monospace,monospace;font-size:.7rem;color:#bfd0c3;background:#0d120f;border:1px solid #29372f;border-radius:5px;padding:1px 5px}
.budget{font-size:.72rem;color:#9aafa0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.78rem;color:#bfd0c3;background:#0d120f;border-radius:8px;padding:8px;max-height:240px;overflow:auto}
body.readonly [data-write]{display:none}
@media(max-width:960px){.cc-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:560px){.cc-budget{grid-template-columns:minmax(0,1fr)}.cc-header-actions{padding-top:0}}`;

export const PLATFORM_UI_JS = `const q=s=>document.querySelector(s);
const esc=v=>{const d=document.createElement('div');d.textContent=v==null?'':String(v);return d.innerHTML};
const token=()=>sessionStorage.getItem('atlas-token')||'';
async function call(method,url,body){
  const init={method,headers:{authorization:'Bearer '+token()}};
  if(body!==undefined){init.headers['content-type']='application/json';init.body=JSON.stringify(body)}
  const r=await fetch(url,init);let data=null;try{data=await r.json()}catch{data=null}
  return {ok:r.ok,status:r.status,data:data||{}};
}
const api=url=>call('GET',url);
function notice(message,error){const n=q('#notice');n.textContent=message||'';n.className='notice'+(error?' error':'')}
const ACTIVE=['proposed','authorized','queued','running','waiting_for_approval','waiting_for_dependency','verifying'];
const pill=s=>'<span class="state state-'+esc(s)+'">'+esc(String(s).split('_').join(' '))+'</span>';
const card=(title,status,body)=>'<article class="task"><div class="task-top"><h3>'+esc(title)+'</h3>'+(status?pill(status):'')+'</div>'+body+'</article>';
const json=v=>'<pre>'+esc(JSON.stringify(v,null,2))+'</pre>';
const usd=micro=>'$'+((Number(micro)||0)/1e6).toFixed(2);
const secs=ms=>Math.round((Number(ms)||0)/1000)+'s';
function budgetText(b){if(!b)return 'no budget';const parts=[];if(b.toolCalls!=null)parts.push(b.toolCalls+' calls');if(b.wallTimeMs!=null)parts.push(secs(b.wallTimeMs));if(b.costMicroUsd!=null)parts.push(usd(b.costMicroUsd));return parts.join(' · ')||'unbounded'}
let selected=null,canWrite=false;
q('#token').value=token();

async function loadRole(){
  const r=await api('/v1/platform/whoami');
  if(!r.ok){q('#role').textContent='locked';q('#unlock').hidden=false;return false}
  canWrite=r.data.canWrite;q('#role').textContent=canWrite?'owner':'read-only device';
  document.body.classList.toggle('readonly',!canWrite);q('#unlock').hidden=true;return true;
}

async function loadTasks(){
  const r=await api('/v1/platform/tasks?limit=200');
  if(r.status===401){q('#tasks').innerHTML='<p class="empty">Your access token was rejected.</p>';q('#unlock').hidden=false;return}
  if(!r.ok){q('#tasks').innerHTML='<p class="empty">'+esc(r.data.message||'Tasks unavailable.')+'</p>';return}
  const filter=q('#filter').value;
  const tasks=(r.data.tasks||[]).filter(t=>!filter||(filter==='active'?ACTIVE.includes(t.status):t.status===filter));
  const blockers={};
  await Promise.all(tasks.filter(t=>t.status.startsWith('waiting_for')).map(async t=>{const b=await api('/v1/platform/tasks/'+t.id+'/blockers');if(b.ok)blockers[t.id]=b.data}));
  q('#tasks').innerHTML=tasks.length?tasks.map(t=>{
    const acts=[];
    if(canWrite&&t.status==='proposed')acts.push('<button class="small" data-action="authorize" data-id="'+esc(t.id)+'">Authorize</button>');
    if(canWrite&&t.status==='authorized')acts.push('<button class="small" data-action="queue" data-id="'+esc(t.id)+'">Queue</button>');
    if(canWrite&&ACTIVE.includes(t.status))acts.push('<button class="small secondary" data-action="cancel" data-id="'+esc(t.id)+'">Cancel</button>');
    acts.push('<button class="small secondary" data-action="open" data-id="'+esc(t.id)+'">Details</button>');
    const why=blockers[t.id]&&blockers[t.id].reason?'<p class="blocked">Why blocked: '+esc(blockers[t.id].reason)+'</p>':'';
    return '<article class="task" data-state="'+esc(t.status)+'"><div class="task-top"><h3>'+esc(t.objective)+'</h3>'+pill(t.status)+'</div>'+why+
      '<p class="meta">'+esc(t.id)+' · '+esc(t.toolCalls)+' tool calls · used '+esc(budgetText(t.usage))+' of '+esc(budgetText(t.budget))+'</p><div class="row-actions">'+acts.join('')+'</div></article>';
  }).join(''):'<p class="empty">No platform tasks'+(filter?' in this state':'')+'.</p>';
}

async function loadDetail(){
  if(!selected)return;
  const r=await api('/v1/platform/tasks/'+encodeURIComponent(selected));
  if(!r.ok)return;
  const d=r.data;
  q('#detail').hidden=false;
  q('#detail-title').textContent=d.task.objective;
  q('#detail-status').innerHTML=pill(d.task.status);
  q('#detail-meta').textContent=d.task.id+' · correlation '+d.task.correlationId+' · tool calls used '+(d.task.usage&&d.task.usage.toolCalls||0)+' of '+(d.task.budget&&d.task.budget.toolCalls!=null?d.task.budget.toolCalls:'unlimited');
  const b=await api('/v1/platform/tasks/'+encodeURIComponent(selected)+'/blockers');
  const line=q('#detail-blocked');
  if(b.ok&&b.data.blocked){line.hidden=false;line.textContent='Why blocked: '+b.data.reason+(b.data.dependencies.length?' Dependencies: '+b.data.dependencies.map(x=>x.objective+' ('+x.status+')').join('; '):'')}else line.hidden=true;
  q('#transitions').innerHTML=d.transitions.map(t=>card(t.from+' → '+t.to,'','<p>'+esc(t.reason)+'</p><time>'+esc(t.createdAt)+'</time>')).join('')||'<p class="empty">None.</p>';
  q('#calls').innerHTML=d.toolCalls.map(c=>card(c.tool,'','<p>'+esc(c.status)+' · '+esc(c.decision?c.decision.effect+': '+c.decision.reasons.join('; '):'no policy decision')+'</p>'+(c.error?'<p>'+esc(c.error.code+': '+c.error.message)+'</p>':'')+(c.durationMs!=null?'<time>'+esc(c.durationMs)+' ms</time>':''))).join('')||'<p class="empty">None.</p>';
  q('#approvals').innerHTML=d.approvals.map(a=>card(a.tool,'','<p>'+esc(a.status)+' · requested by '+esc(a.requestedBy)+'</p>')).join('')||'<p class="empty">None.</p>';
  q('#artifacts').innerHTML=d.artifacts.map(a=>card(a.kind,'','<p>'+esc(a.verification)+'</p>'+json(a.content)+'<h4>Verification evidence</h4>'+json(a.verificationEvidence||[]))).join('')||'<p class="empty">None.</p>';
  q('#events').innerHTML=d.events.map(e=>card(e.type,'','<time>'+esc(e.createdAt)+'</time>')).join('')||'<p class="empty">None.</p>';
}

async function loadInbox(){
  const r=await api('/v1/platform/approvals?status=pending');if(!r.ok)return;
  const list=r.data.approvals||[];
  q('#approval-count').textContent=String(list.length);
  q('#inbox').innerHTML=list.map(a=>'<article class="task"><div class="task-top"><h3>'+esc(a.tool)+'</h3>'+pill('waiting_for_approval')+'</div><p>'+esc(a.task?a.task.objective:a.taskId)+'</p><p class="meta">requested by '+esc(a.requestedBy||'unknown')+(a.expiresAt?' · expires '+esc(new Date(a.expiresAt).toLocaleString()):'')+'</p>'+
    (canWrite?'<div class="row-actions"><button class="small" data-action="approve" data-id="'+esc(a.id)+'">Approve</button><button class="small secondary" data-action="reject" data-id="'+esc(a.id)+'">Reject</button></div>':'')+'</article>').join('')||'<p class="empty">Nothing waiting.</p>';
}

async function loadCosts(){
  const r=await api('/v1/platform/costs');if(!r.ok)return;
  const t=r.data.totals;
  const stats=[['Tool calls',t.toolCalls],['Wall time',secs(t.wallTimeMs)],['Tokens',(t.inputTokens+t.outputTokens).toLocaleString()],['Cost',usd(t.costMicroUsd)]];
  const rows=(r.data.agents||[]).map(a=>'<tr><td>'+esc(a.name||a.agentId||'unassigned')+'</td><td>'+esc(a.tasks)+'</td><td>'+esc(a.usage.toolCalls)+'</td><td>'+esc(usd(a.usage.costMicroUsd))+'</td></tr>').join('');
  q('#costs').innerHTML='<div class="stats">'+stats.map(s=>'<div class="stat"><span>'+esc(s[0])+'</span><b>'+esc(s[1])+'</b></div>').join('')+'</div>'+(rows?'<table><thead><tr><th>Agent</th><th>Tasks</th><th>Calls</th><th>Cost</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p class="empty">No usage yet.</p>');
}

async function loadWorkers(){
  const r=await api('/v1/platform/workers');if(!r.ok)return;
  const w=r.data;
  const row=(name,ok,detail)=>'<div><span>'+esc(name)+'</span><span class="'+(ok?'ok':'bad')+'">'+esc(detail)+'</span></div>';
  q('#workers').innerHTML='<div class="health">'+
    row('Browser worker',w.browser.available,w.browser.available?'playwright-core ready':'unavailable')+
    row('Terminal',w.terminal.available,w.terminal.available?(w.terminal.capabilities.rlimits&&w.terminal.capabilities.rlimits.tool?'no shell · rlimits':'no shell')+' · '+w.terminal.workspaces+' workspaces':'unavailable')+
    row('MCP gateway',w.mcp.available,w.mcp.available?w.mcp.servers.length+' servers registered':'unavailable')+
    row('Memory',w.memory.available,w.memory.available?'search: '+w.memory.searchMode:'unavailable')+
    row('Agent family',w.familyRegistry.available,w.familyRegistry.available?'registry running':'unavailable')+'</div>'+
    (!w.browser.available&&w.browser.reason?'<p class="hint">'+esc(w.browser.reason)+'</p>':'');
}

function agentNode(a){
  const perms=(a.permissions||[]).map(p=>'<span class="perm">'+esc(p)+'</span>').join(' ');
  const action=canWrite&&a.state==='proposed'?' <button class="small" data-action="authorize-agent" data-id="'+esc(a.id)+'">Authorize</button>':'';
  return '<li><div class="agent"><b>'+esc(a.name||a.id)+'</b><span class="tag">'+esc(a.role)+'</span><span class="tag">'+esc(a.family)+'</span>'+pill(a.state)+'<span class="budget">budget '+esc(budgetText(a.budget))+'</span>'+action+'</div><div>'+perms+'</div>'+
    (a.children&&a.children.length?'<ul>'+a.children.map(agentNode).join('')+'</ul>':'')+'</li>';
}
async function loadFamily(){
  const r=await api('/v1/platform/family');
  if(!r.ok){q('#family').innerHTML='<p class="empty">'+esc(r.data.message||'Family registry unavailable.')+'</p>';return}
  q('#family-counts').textContent=Object.entries(r.data.counts||{}).map(e=>e[1]+' '+e[0]).join(' · ');
  q('#family').innerHTML=r.data.trees.length?'<ul>'+r.data.trees.map(agentNode).join('')+'</ul>':'<p class="empty">No agents.</p>';
}

async function loadMemory(){
  const query=q('#memory-query').value;
  const r=await api('/v1/platform/memory?limit=50'+(query?'&query='+encodeURIComponent(query):''));
  if(!r.ok){q('#memory').innerHTML='<p class="empty">'+esc(r.data.message||'Memory unavailable.')+'</p>';return}
  q('#memory').innerHTML=r.data.entries.map(e=>'<article class="task"><div class="task-top"><h3>'+esc(e.content)+'</h3><span class="tag">'+esc(e.kind)+'</span></div><p class="meta">'+esc(e.scope+':'+e.scope_ref)+' · v'+esc(e.version)+' · '+esc(e.provenance&&e.provenance.source)+(e.redacted?' · redacted':'')+'</p>'+
    (canWrite?'<div class="row-actions"><button class="small secondary" data-action="delete-memory" data-id="'+esc(e.id)+'">Delete</button></div>':'')+'</article>').join('')||'<p class="empty">No memory entries'+(query?' match':'')+'.</p>';
}

async function loadAll(){if(!(await loadRole()))return loadTasks();await Promise.all([loadTasks(),loadInbox(),loadCosts(),loadWorkers(),loadFamily(),loadMemory(),loadDetail()])}

async function act(button){
  const id=button.dataset.id,action=button.dataset.action;let r=null;
  if(action==='open'){selected=id;await loadDetail();q('#detail').scrollIntoView({behavior:'smooth'});return}
  if(action==='authorize')r=await call('POST','/v1/platform/tasks/'+id+'/transitions',{to:'authorized'});
  if(action==='queue')r=await call('POST','/v1/platform/tasks/'+id+'/transitions',{to:'queued'});
  if(action==='cancel'){if(!confirm('Cancel this task and every task delegated from it?'))return;r=await call('POST','/v1/platform/tasks/'+id+'/cancel',{})}
  if(action==='approve')r=await call('POST','/v1/platform/approvals/'+id+'/decision',{decision:'approve'});
  if(action==='reject')r=await call('POST','/v1/platform/approvals/'+id+'/decision',{decision:'reject'});
  if(action==='authorize-agent')r=await call('POST','/v1/platform/agents/'+id+'/authorize',{});
  if(action==='delete-memory'){if(!confirm('Erase this memory entry and all of its versions?'))return;r=await call('DELETE','/v1/platform/memory/'+id)}
  if(r)notice(r.ok?'Done.':(r.data.message||'Request failed ('+r.status+').'),!r.ok);
  await loadAll();
}
document.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(b){e.preventDefault();act(b)}});

q('#composer').onsubmit=async e=>{
  e.preventDefault();
  const successCriteria=q('#criteria').value.split(String.fromCharCode(10)).map(s=>s.trim()).filter(Boolean);
  const budget={};
  const calls=q('#budget-calls').value,minutes=q('#budget-minutes').value,dollars=q('#budget-usd').value;
  if(calls!=='')budget.toolCalls=Math.floor(Number(calls));
  if(minutes!=='')budget.wallTimeMs=Math.floor(Number(minutes)*60000);
  if(dollars!=='')budget.costMicroUsd=Math.round(Number(dollars)*1e6);
  const r=await call('POST','/v1/platform/tasks',{objective:q('#objective').value.trim(),successCriteria,budget});
  notice(r.ok?'Task proposed. Authorize it to let it run.':(r.data.message||'Could not create the task.'),!r.ok);
  if(r.ok){q('#objective').value='';q('#criteria').value='';selected=r.data.task.id}
  loadAll();
};
q('#memory-search').onsubmit=e=>{e.preventDefault();loadMemory()};
q('#memory-add').onsubmit=async e=>{e.preventDefault();const content=q('#memory-content').value.trim();if(!content)return;const r=await call('POST','/v1/platform/memory',{content});notice(r.ok?'Remembered.':(r.data.message||'Could not store it.'),!r.ok);if(r.ok)q('#memory-content').value='';loadMemory()};
q('#emergency-stop').onclick=async()=>{
  if(!confirm('Emergency stop: cancel every task in flight and reject every pending approval?'))return;
  const r=await call('POST','/v1/platform/emergency-stop',{confirm:true,reason:'stopped from the command center'});
  notice(r.ok?'Emergency stop: '+r.data.cancelled.length+' task(s) cancelled, '+r.data.rejectedApprovals.length+' approval(s) rejected.':(r.data.message||'Emergency stop failed.'),!r.ok);
  loadAll();
};
q('#save-token').onclick=()=>{sessionStorage.setItem('atlas-token',q('#token').value);loadAll()};
q('#refresh').onclick=()=>loadAll();
q('#filter').onchange=()=>loadTasks();
if(token())loadAll();
setInterval(()=>{if(token()&&!document.hidden){loadTasks();loadInbox();loadCosts();loadDetail()}},4000);
`;
