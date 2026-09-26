import { isAbsolute } from "node:path";

import { LOCAL_TENANT_ID } from "../dashboard.mjs";
import { InnovationError, OPPORTUNITY_STATES } from "./brief.mjs";
import { collectRepositorySignals } from "./signals.mjs";

/**
 * HTTP surface of the innovation pipeline, mounted on the local control
 * plane after authentication. Reads are open to any authenticated caller;
 * agent-step writes need the owner token; build and launch decisions are
 * recorded against the authenticated human (owner or a paired device), never
 * against a name supplied in the body.
 */

const OPP_ID = "opp_[0-9a-f]{32}";

/**
 * Operational failures translate into a structured reason and the minimum
 * action that unblocks them, instead of a bare error code.
 */
const BLOCKED = {
  MISSING_PERMISSION: ["BLOCKED_BY_PERMISSION", "Ask an agent that holds the needed permission, or grant it to this agent's family through policy."],
  AGENT_NOT_ACTIVE: ["BLOCKED_BY_DEPENDENCY", "Seed or re-activate the agent organization, then retry."],
  HUMAN_DECISION_REQUIRED: ["BLOCKED_BY_POLICY", "A person must make this decision from the Innovation Backlog or the approvals inbox."],
  AGENT_CANNOT_APPROVE: ["BLOCKED_BY_POLICY", "A person must make this decision; agents cannot approve builds or launches."],
  NOT_APPROVED: ["BLOCKED_BY_POLICY", "Approve the current Decision Packet before commissioning the build."],
  STALE_DECISION_PACKET: ["BLOCKED_BY_POLICY", "Reload the opportunity and review the current Decision Packet."],
  DUPLICATE_OPPORTUNITY: ["BLOCKED_BY_POLICY", "Open the matching opportunity instead, or resubmit naming it in 'supersedes' with new evidence."],
  NO_NEW_EVIDENCE: ["BLOCKED_BY_POLICY", "Add evidence the earlier idea did not have."],
  COUNCIL_INCOMPLETE: ["BLOCKED_BY_DEPENDENCY", "Wait for the missing council members to review."],
  COUNCIL_NOT_CONVENED: ["BLOCKED_BY_DEPENDENCY", "Convene the council for this proposal round first."],
  PEER_UNAVAILABLE: ["BLOCKED_BY_CAPABILITY", "Seed the missing peer organization, or remove it from the proposal's commission list."],
  INSUFFICIENT_EVIDENCE: ["BLOCKED_BY_POLICY", "Attach test, behavioral, visual or security evidence."],
  CONFIDENCE_NOT_SUPPORTED: ["BLOCKED_BY_POLICY", "Lower the confidence level or add strong, independent evidence."],
  ORIGINALITY_REQUIRED: ["BLOCKED_BY_POLICY", "Explain how the solution is an original design rather than a copy."],
  NOT_A_REPOSITORY: ["BLOCKED_BY_DEPENDENCY", "Point the scan at a local git working tree."],
};

export function describeInnovationError(error) {
  const code = error?.code ?? "ERROR";
  const [blocked, unblock] = BLOCKED[code] ?? [null, null];
  const status = code === "OPPORTUNITY_NOT_FOUND" ? 404
    : code === "CONCURRENT_UPDATE" || code === "DUPLICATE_OPPORTUNITY" || code === "ALREADY_REVIEWED" || code.startsWith("ILLEGAL_") || code === "STALE_DECISION_PACKET" ? 409
      : blocked === "BLOCKED_BY_PERMISSION" || code === "AGENT_CANNOT_APPROVE" ? 403
        : 400;
  return { status, body: { code, message: error instanceof Error ? error.message : "Request failed.", ...(blocked ? { blocked, unblock } : {}), ...(error?.details ? { details: error.details } : {}) } };
}

export function createInnovationRoutes({ pipeline, organization = null, tenantFor = () => LOCAL_TENANT_ID, parseBody, send, collectSignals = collectRepositorySignals }) {
  if (!pipeline) throw new TypeError("pipeline is required.");

  function handlePage(request, response) {
    if (request.method !== "GET") return false;
    if (request.url === "/innovation") return sendText(response, "text/html; charset=utf-8", INNOVATION_UI_HTML);
    if (request.url === "/innovation.js") return sendText(response, "text/javascript; charset=utf-8", INNOVATION_UI_JS);
    return false;
  }

  const human = (identity) => ({ kind: "human", id: identity.role === "admin" ? "local-owner" : `device:${identity.device?.id ?? "unknown"}` });

  async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/innovation/")) return false;
    const tenantId = tenantFor(identity);
    const run = async (fn) => {
      try { return send(response, 200, await fn()); }
      catch (error) {
        // An unexpected failure must not escape the request handler and take the daemon down.
        if (!(error instanceof InnovationError) && typeof error?.code !== "string") {
          return send(response, 500, { code: "INTERNAL_ERROR", message: "The innovation pipeline failed unexpectedly. Nothing was changed by the failed step; retry, and check the daemon log if it repeats." });
        }
        const { status, body } = describeInnovationError(error);
        return send(response, status, body);
      }
    };

    if (request.method === "GET") {
      if (url.pathname === "/v1/innovation/backlog") {
        const state = url.searchParams.get("state") || undefined;
        return run(() => ({ states: OPPORTUNITY_STATES, opportunities: pipeline.backlog(tenantId, { state }) }));
      }
      if (url.pathname === "/v1/innovation/memory") {
        const query = (url.searchParams.get("q") ?? "").slice(0, 2000);
        if (!query.trim()) return send(response, 400, { message: "q is required." });
        return run(() => ({ matches: pipeline.searchMemory(tenantId, query, { limit: 20 }) }));
      }
      if (url.pathname === "/v1/innovation/organization") return run(() => ({ organization: organization ? organization(tenantId) : null, policy: pipeline.policy }));
      const detail = new RegExp(`^/v1/innovation/opportunities/(${OPP_ID})$`, "u").exec(url.pathname);
      if (detail) return run(() => pipeline.detail(tenantId, detail[1]));
      return send(response, 404, { message: "Route not found." });
    }

    if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });

    // Human decisions: the owner or a paired approval device.
    const decision = new RegExp(`^/v1/innovation/opportunities/(${OPP_ID})/(decision|launch)$`, "u").exec(url.pathname);
    if (decision) {
      const body = await parseBody(request, response); if (!body) return true;
      if (decision[2] === "decision") return run(() => ({ opportunity: pipeline.decide(tenantId, decision[1], { decision: body.decision, packetDigest: body.packetDigest, note: body.note ?? null, decidedBy: human(identity) }) }));
      return run(() => ({ opportunity: pipeline.launch(tenantId, decision[1], { packetDigest: body.packetDigest, note: body.note ?? null, decidedBy: human(identity) }) }));
    }

    // Everything else acts on behalf of an agent and needs the owner token.
    if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", blocked: "BLOCKED_BY_PERMISSION", unblock: "Use the local owner token." });
    const body = await parseBody(request, response); if (!body) return true;

    if (url.pathname === "/v1/innovation/opportunities") {
      return run(() => pipeline.submitOpportunity(tenantId, { agentId: body.agentId, brief: body.brief, supersedes: body.supersedes ?? null }));
    }
    if (url.pathname === "/v1/innovation/signals") {
      const repository = typeof body.repository === "string" ? body.repository : "";
      if (!isAbsolute(repository) || repository.length > 4096) return send(response, 400, { message: "repository must be an absolute path to a local git working tree." });
      return run(() => collectSignals(repository));
    }
    const step = new RegExp(`^/v1/innovation/opportunities/(${OPP_ID})/(research-request|research|product-review|council|council-reviews|packet|commission|verification|measurements|conclusion|lessons|archive)$`, "u").exec(url.pathname);
    if (!step) return send(response, 404, { message: "Route not found." });
    const [, id, action] = step;
    const agentId = body.agentId;
    switch (action) {
      case "research-request": return run(() => ({ opportunity: pipeline.startResearch(tenantId, id, { agentId, questions: body.questions ?? [] }) }));
      case "research": return run(() => ({ opportunity: pipeline.recordResearch(tenantId, id, { agentId, supported: body.supported, findings: body.findings, sources: body.sources ?? [] }) }));
      case "product-review": return run(() => ({ opportunity: pipeline.productReview(tenantId, id, { agentId, decision: body.decision, proposal: body.proposal ?? null, reason: body.reason ?? null, questions: body.questions ?? [] }) }));
      case "council": return run(() => ({ opportunity: pipeline.convene(tenantId, id, { agentId }) }));
      case "council-reviews": return run(() => ({ reviews: pipeline.submitCouncilReview(tenantId, id, { agentId, review: body.review }) }));
      case "packet": return run(() => ({ opportunity: pipeline.finalizeDecisionPacket(tenantId, id, { agentId }) }));
      case "commission": return run(() => ({ opportunity: pipeline.commission(tenantId, id, { agentId }) }));
      case "verification": return run(() => ({ opportunity: pipeline.recordVerification(tenantId, id, { agentId, passed: body.passed, evidence: body.evidence ?? [] }) }));
      case "measurements": return run(() => ({ opportunity: pipeline.recordMeasurement(tenantId, id, { agentId, metric: body.metric, before: body.before ?? null, after: body.after, source: body.source }) }));
      case "conclusion": return run(() => ({ opportunity: pipeline.conclude(tenantId, id, { agentId, outcome: body.outcome, summary: body.summary, lessons: body.lessons }) }));
      case "lessons": return run(() => ({ lessons: pipeline.recordLesson(tenantId, id, { actor: "local-owner", lesson: body.lesson }) }));
      case "archive": return run(() => ({ opportunity: pipeline.archive(tenantId, id, { actor: "local-owner", reason: body.reason }) }));
      default: return send(response, 404, { message: "Route not found." });
    }
  }

  return { handlePage, handle };
}

function sendText(response, contentType, value) {
  response.setHeader("content-type", contentType);
  response.writeHead(200);
  response.end(value);
  return true;
}

export const INNOVATION_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Innovation Backlog</title><link rel="stylesheet" href="/app.css"></head>
<body><main><header><div><p class="eyebrow">BUSINESS DEVELOPMENT</p><h1>Innovation Backlog</h1><p class="hint">Evidence-backed opportunities Atlas has discovered, what the council thinks, and what needs your decision. Separate from engineering TODOs.</p></div><a href="/">Control plane</a></header>
<section class="panel"><h2>Local access</h2><label>Access token<input id="token" type="password" autocomplete="off" placeholder="Paste the token printed at first launch"></label><button id="save-token">Unlock this tab</button></section>
<section><div class="section-title"><h2>Opportunities</h2><label>State <select id="state"><option value="">All</option></select></label><button class="secondary" id="refresh">Refresh</button></div><div id="list" class="tasks"><p class="empty">Unlock this tab to load the backlog.</p></div></section>
<section class="panel" id="detail" hidden><div class="section-title"><h2 id="detail-title">Opportunity</h2><span class="status" id="detail-status"></span></div>
<div id="decision" hidden><p><strong>Atlas discovered a potential product improvement.</strong></p><p class="hint" id="decision-meta"></p>
<label>Note (required to modify or reject)<input id="note" type="text" maxlength="2000"></label>
<div class="actions"><button id="review">Review Proposal</button><button id="approve">Approve Build</button><button class="secondary" id="modify">Modify</button><button class="secondary" id="reject">Reject</button></div></div>
<div id="launch" hidden><p><strong>The build passed verification.</strong> Launch follows your deployment policy.</p><button id="launch-btn">Authorize launch</button></div>
<p class="hint" id="message" role="status"></p>
<h3>Brief</h3><div id="brief"></div>
<h3>Decision Packet</h3><div id="packet"><p class="empty">Not prepared yet.</p></div>
<h3>Council</h3><div id="reviews" class="tasks"></div>
<h3>Build progress</h3><div id="progress" class="tasks"></div>
<h3>Results and lessons</h3><div id="results" class="tasks"></div>
<h3>Related ideas in Opportunity Memory</h3><div id="related" class="tasks"></div>
<h3>History</h3><div id="events" class="tasks"></div></section>
</main><script type="module" src="/innovation.js"></script></body></html>`;

export const INNOVATION_UI_JS = `const q=s=>document.querySelector(s);
const esc=v=>{const d=document.createElement('div');d.textContent=v==null?'':String(v);return d.innerHTML};
const auth=()=>({authorization:'Bearer '+(sessionStorage.getItem('atlas-token')||'')});
const api=(url,body)=>fetch(url,body?{method:'POST',headers:{...auth(),'content-type':'application/json'},body:JSON.stringify(body)}:{headers:auth()});
q('#token').value=sessionStorage.getItem('atlas-token')||'';
let selected=null,current=null;
const card=(title,status,body)=>'<article class="task"><div class="task-top"><h3>'+esc(title)+'</h3>'+(status?'<span class="status">'+esc(status)+'</span>':'')+'</div>'+body+'</article>';
const ul=items=>items&&items.length?'<ul>'+items.map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul>':'<p class="empty">None.</p>';
async function loadList(){
  const state=q('#state').value;
  const r=await api('/v1/innovation/backlog'+(state?'?state='+encodeURIComponent(state):''));
  if(r.status===401){q('#list').innerHTML='<p class="empty">Your access token was rejected.</p>';return}
  const d=await r.json();
  if(q('#state').options.length===1)d.states.forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;q('#state').appendChild(o)});
  q('#list').innerHTML=d.opportunities.length?d.opportunities.map(o=>'<button type="button" class="secondary" data-id="'+esc(o.id)+'">'+(o.needsHuman?'● ':'')+esc(o.state)+' · '+esc(o.title)+' · '+esc(o.estimatedEffort)+' · confidence '+esc(o.confidence.level)+' · '+esc(o.evidence.count)+' evidence'+(o.progress?' · build '+esc(o.progress.done)+'/'+esc(o.progress.total):'')+'</button>').join(''):'<p class="empty">No opportunities yet. The Business Development Executive only proposes work it can back with evidence.</p>';
  q('#list').querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.id;loadDetail()});
}
async function loadDetail(){
  if(!selected)return;
  const r=await api('/v1/innovation/opportunities/'+encodeURIComponent(selected));
  if(!r.ok)return;
  const d=await r.json();current=d.opportunity;
  const o=d.opportunity,b=o.brief,p=o.decisionPacket;
  q('#detail').hidden=false;
  q('#detail-title').textContent=o.title;q('#detail-status').textContent=o.state;
  q('#decision').hidden=o.state!=='NEEDS_REVIEW';q('#launch').hidden=o.state!=='READY_TO_LAUNCH';
  if(p)q('#decision-meta').textContent=p.estimatedEffort+' effort · council: '+p.consensus.replaceAll('_',' ')+' · packet '+o.packetDigest.slice(0,23)+'…';
  q('#brief').innerHTML=card('Problem','', '<p>'+esc(b.problem)+'</p><p><strong>Target user:</strong> '+esc(b.targetUser)+'</p><p><strong>Value hypothesis:</strong> '+esc(b.valueHypothesis)+'</p><p><strong>Confidence:</strong> '+esc(b.confidence.level)+' — '+esc(b.confidence.reasons.join('; '))+'</p>')
    +card('Evidence','',ul(b.evidence.map(e=>e.strength+' · '+e.kind+': '+e.summary+' ('+e.source+')')));
  q('#packet').innerHTML=p?card('Recommended specification',p.consensus,'<p>'+esc(p.recommendedSpecification.summary)+'</p><h4>MVP</h4>'+ul(p.recommendedSpecification.mvpScope)+'<h4>Acceptance criteria</h4>'+ul(p.recommendedSpecification.acceptanceCriteria)+'<h4>Out of scope</h4>'+ul(p.recommendedSpecification.outOfScope)+'<h4>Risks</h4>'+ul(p.risks.map(x=>x.category+': '+x.description))+'<h4>Success metrics</h4>'+ul(p.successMetrics.map(m=>m.name+' → '+m.target))+'<h4>Alternatives considered</h4>'+ul(p.alternativesConsidered)+'<h4>Implementation plan</h4>'+ul(p.implementationPlan)+(p.vacantSeats.length?'<p class="hint">Vacant seats: '+esc(p.vacantSeats.join(', '))+'</p>':'')):'<p class="empty">Not prepared yet.</p>';
  q('#reviews').innerHTML=d.reviews.map(v=>card(v.seat+' (round '+v.round+')',v.stance,'<p>'+esc(v.summary)+'</p>'+(v.conditions.length?'<h4>Conditions</h4>'+ul(v.conditions):''))).join('')||'<p class="empty">No council reviews.</p>';
  const pr=d.card.progress;
  q('#progress').innerHTML=pr?pr.subtasks.map(s=>card(s.family+' · '+s.agent,s.state+(s.verified?' ✓':''),'')).join('')+(pr.platformTask?'<p class="hint">Platform task '+esc(pr.platformTask.id)+' · '+esc(pr.platformTask.status)+'</p>':''):'<p class="empty">Not commissioned.</p>';
  q('#results').innerHTML=(d.measurements.map(m=>card(m.metric,'',('<p>'+esc(m.before==null?'':m.before+' → ')+esc(m.after)+'</p><p class="hint">'+esc(m.source)+'</p>'))).join(''))+(d.lessons.length?card('Lessons','',ul(d.lessons.map(l=>l.lesson))):'')+(o.rejectionReason?card('Why it was rejected','',('<p>'+esc(o.rejectionReason)+'</p>')):'')||'<p class="empty">No results yet.</p>';
  q('#related').innerHTML=d.related.map(m=>card(m.title,m.state,'<p>similarity '+esc(m.similarity)+'</p>'+(m.rejectionReason?'<p>'+esc(m.rejectionReason)+'</p>':''))).join('')||'<p class="empty">Nothing similar.</p>';
  q('#events').innerHTML=d.events.slice().reverse().map(e=>card(e.type,e.to,'<p class="hint">'+esc(e.actor)+'</p><time>'+esc(e.at)+'</time>')).join('');
}
async function decide(decision){
  if(!current)return;
  const r=await api('/v1/innovation/opportunities/'+current.id+'/decision',{decision,packetDigest:current.packetDigest,note:q('#note').value||null});
  const d=await r.json();
  q('#message').textContent=r.ok?'Recorded: '+decision+'.':(d.message+(d.unblock?' '+d.unblock:''));
  loadList();loadDetail();
}
q('#review').onclick=()=>q('#packet').scrollIntoView({behavior:'smooth'});
q('#approve').onclick=()=>decide('approve');q('#modify').onclick=()=>decide('modify');q('#reject').onclick=()=>decide('reject');
q('#launch-btn').onclick=async()=>{const r=await api('/v1/innovation/opportunities/'+current.id+'/launch',{packetDigest:current.packetDigest});const d=await r.json();q('#message').textContent=r.ok?'Launch authorized.':(d.message+(d.unblock?' '+d.unblock:''));loadList();loadDetail()};
q('#save-token').onclick=()=>{sessionStorage.setItem('atlas-token',q('#token').value);loadList()};
q('#refresh').onclick=()=>{loadList();loadDetail()};q('#state').onchange=loadList;
if(q('#token').value)loadList();
setInterval(()=>{if(sessionStorage.getItem('atlas-token')){loadList()}},10000);
`;
