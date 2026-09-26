/**
 * Minimal platform dashboard (blueprint §21 item 6): a task's status, its
 * state transitions, every tool call with its policy decision, its artifacts
 * with verification evidence, and its correlated audit events.
 *
 * Read-only on purpose. Approving, cancelling and replaying are separate,
 * policy-checked operations that belong behind their own routes; a view that
 * could also act would make every rendering bug a potential action.
 *
 * The local daemon has one owner, so everything it runs lives in one tenant.
 * The tenant is still passed on every read so that the same routes serve a
 * multi-tenant store unchanged once identity carries a tenant.
 */
export const LOCAL_TENANT_ID = "local";

const TASK_ID = "tsk_[0-9a-f]{32}";
const MAX_LIST = 200;

export function createPlatformRoutes({ store, tenantFor = () => LOCAL_TENANT_ID, stream = null }) {
  if (!store) throw new TypeError("store is required.");

  /** Pages carry no data, so they are served before authentication. */
  function handlePage(request, response) {
    if (request.method !== "GET") return false;
    if (request.url === "/platform") return sendText(response, 200, "text/html; charset=utf-8", PLATFORM_UI_HTML);
    if (request.url === "/platform.js") return sendText(response, 200, "text/javascript; charset=utf-8", PLATFORM_UI_JS);
    return false;
  }

  /** Data routes run only after the caller's token was accepted. */
  function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/platform/")) return false;
    if (request.method !== "GET") return send(response, 405, { message: "The platform dashboard is read-only." });
    // Live events, delivered from the transactional outbox.
    if (url.pathname === "/v1/platform/stream") {
      if (!stream) return send(response, 503, { message: "Live events are not running in this process." });
      stream.attach(request, response, identity);
      return true;
    }
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

export const PLATFORM_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas Tasks</title><link rel="stylesheet" href="/app.css"></head>
<body><main><header><div><p class="eyebrow">PLATFORM TASKS</p><h1>Atlas Tasks</h1></div><a href="/">Control plane</a></header>
<section class="panel"><h2>Local access</h2><label>Access token<input id="token" type="password" autocomplete="off" placeholder="Paste the token printed at first launch"></label><button id="save-token">Unlock this tab</button></section>
<section><div class="section-title"><h2>Tasks</h2><button class="secondary" id="refresh">Refresh</button></div><div id="tasks" class="tasks"><p class="empty">Unlock this tab to load tasks.</p></div></section>
<section class="panel" id="detail" hidden><div class="section-title"><h2 id="detail-title">Task</h2><span class="status" id="detail-status"></span></div>
<p class="hint" id="detail-meta"></p>
<h3>Transitions</h3><div id="transitions" class="tasks"></div>
<h3>Tool calls</h3><div id="calls" class="tasks"></div>
<h3>Approvals</h3><div id="approvals" class="tasks"></div>
<h3>Artifacts</h3><div id="artifacts" class="tasks"></div>
<h3>Events</h3><div id="events" class="tasks"></div></section>
</main><script type="module" src="/platform.js"></script></body></html>`;

export const PLATFORM_UI_JS = `const q=s=>document.querySelector(s);
const esc=v=>{const d=document.createElement('div');d.textContent=v==null?'':String(v);return d.innerHTML};
const api=url=>fetch(url,{headers:{authorization:'Bearer '+(sessionStorage.getItem('atlas-token')||'')}});
q('#token').value=sessionStorage.getItem('atlas-token')||'';
let selected=null;
const card=(title,status,body)=>'<article class="task"><div class="task-top"><h3>'+esc(title)+'</h3>'+(status?'<span class="status '+esc(status)+'">'+esc(status)+'</span>':'')+'</div>'+body+'</article>';
const json=v=>'<pre>'+esc(JSON.stringify(v,null,2))+'</pre>';
async function loadTasks(){
  const r=await api('/v1/platform/tasks');
  if(r.status===401){q('#tasks').innerHTML='<p class="empty">Your access token was rejected.</p>';return}
  const {tasks}=await r.json();
  q('#tasks').innerHTML=tasks.length?tasks.map(t=>'<button type="button" class="secondary" data-task="'+esc(t.id)+'">'+esc(t.status)+' · '+esc(t.objective)+' · '+esc(t.toolCalls)+' tool calls</button>').join(''):'<p class="empty">No platform tasks yet.</p>';
  q('#tasks').querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.task;loadDetail()});
}
async function loadDetail(){
  if(!selected)return;
  const r=await api('/v1/platform/tasks/'+encodeURIComponent(selected));
  if(!r.ok)return;
  const d=await r.json();
  q('#detail').hidden=false;
  q('#detail-title').textContent=d.task.objective;
  q('#detail-status').textContent=d.task.status;
  q('#detail-status').className='status '+d.task.status;
  q('#detail-meta').textContent=d.task.id+' · correlation '+d.task.correlationId+' · tool calls used '+(d.task.usage&&d.task.usage.toolCalls||0)+' of '+(d.task.budget&&d.task.budget.toolCalls!=null?d.task.budget.toolCalls:'unlimited');
  q('#transitions').innerHTML=d.transitions.map(t=>card(t.from+' → '+t.to,'',  '<p>'+esc(t.reason)+'</p><time>'+esc(t.createdAt)+'</time>')).join('')||'<p class="empty">None.</p>';
  q('#calls').innerHTML=d.toolCalls.map(c=>card(c.tool,c.status,'<p>'+esc(c.decision?c.decision.effect+': '+c.decision.reasons.join('; '):'no policy decision')+'</p>'+(c.error?'<p>'+esc(c.error.code+': '+c.error.message)+'</p>':'')+(c.durationMs!=null?'<time>'+esc(c.durationMs)+' ms</time>':''))).join('')||'<p class="empty">None.</p>';
  q('#approvals').innerHTML=d.approvals.map(a=>card(a.tool,a.status,'<p>requested by '+esc(a.requestedBy)+'</p>')).join('')||'<p class="empty">None.</p>';
  q('#artifacts').innerHTML=d.artifacts.map(a=>card(a.kind,a.verification,json(a.content)+'<h4>Verification evidence</h4>'+json(a.verificationEvidence||[]))).join('')||'<p class="empty">None.</p>';
  q('#events').innerHTML=d.events.map(e=>card(e.type,'','<time>'+esc(e.createdAt)+'</time>')).join('')||'<p class="empty">None.</p>';
}
q('#save-token').onclick=()=>{sessionStorage.setItem('atlas-token',q('#token').value);loadTasks()};
q('#refresh').onclick=()=>{loadTasks();loadDetail()};
if(q('#token').value)loadTasks();
// Live updates from the outbox; a slow poll remains as a fallback.
let pending=null;
const refresh=()=>{clearTimeout(pending);pending=setTimeout(()=>{loadTasks();loadDetail()},150)};
async function live(){
  if(!sessionStorage.getItem('atlas-token'))return setTimeout(live,2000);
  try{
    const r=await api('/v1/platform/stream');
    if(!r.ok||!r.body)throw new Error('no stream');
    const reader=r.body.getReader();
    for(;;){const {done,value}=await reader.read();if(done)break;if(new TextDecoder().decode(value).includes('event: '))refresh()}
  }catch(e){}
  setTimeout(live,3000);
}
live();
setInterval(()=>{if(sessionStorage.getItem('atlas-token')){loadTasks();loadDetail()}},30000);
`;
