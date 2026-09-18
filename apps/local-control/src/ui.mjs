export const LOCAL_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas Local</title><link rel="stylesheet" href="/app.css"></head>
<body><main><header><div><p class="eyebrow">SOVEREIGN CONTROL PLANE</p><h1>Atlas Local</h1></div><span id="health">Checking model…</span></header>
<section class="panel"><h2>Local access</h2><label>Access token<input id="token" type="password" autocomplete="off" placeholder="Paste the token printed at first launch"></label><button id="save-token">Unlock this tab</button><p class="hint">Stored only for this browser tab. Atlas binds to this computer by default.</p></section>
<section class="panel"><div class="section-title"><h2>Conversation</h2><select id="session-picker"><option value="">New session…</option></select></div>
<form id="session-form"><label>Repository folder<input id="session-repository" placeholder="C:\\path\\to\\project"></label><label>Model<select id="session-model"><option>qwen2.5-coder:7b</option></select></label><label>Executor<select id="session-executor"><option value="local">local</option></select></label></form>
<div id="transcript" class="transcript"><p class="empty">Unlock this tab, then send a message to start a session.</p></div>
<p id="run-status" class="hint"></p>
<form id="turn-form"><label>Message<textarea id="turn-text" maxlength="10000" placeholder="Describe what you want Atlas to do, or reply to what it just said"></textarea></label><label>Attachments<input id="attachments" type="file" multiple accept="image/*,text/*,.pdf,.md,.json,.csv"></label><div class="actions"><button>Send</button><button type="button" class="secondary" id="dictate">Dictate</button><button type="button" class="secondary" id="pause">Pause</button><button type="button" class="secondary" id="resume">Resume</button><button type="button" class="secondary" id="stop">Stop</button><button type="button" class="secondary" id="retry">Retry</button><button type="button" class="secondary" id="regenerate">Regenerate</button><button type="button" class="secondary" id="edit-last">Edit last</button></div></form></section>
<section class="panel"><h2>Run local coder</h2><form id="task-form"><label>Repository folder<input id="repository" required placeholder="C:\\path\\to\\project"></label><label>Objective<textarea id="objective" required maxlength="10000" placeholder="Describe one bounded change"></textarea></label><label>Discovered local model<select id="model"><option>qwen2.5-coder:7b</option></select></label><button>Queue isolated task</button></form><p id="notice" role="status"></p></section>
<section><div class="section-title"><h2>Tasks</h2><button class="secondary" id="refresh">Refresh</button></div><div id="tasks" class="tasks"><p class="empty">Unlock this tab to load tasks.</p></div></section>
<section class="panel"><div class="section-title"><h2>Approvals</h2><div class="actions"><button class="secondary" id="notify">Enable notifications</button><button class="secondary" id="pair">Pair phone</button></div></div><p id="pair-code" role="status"></p><div id="approvals" class="tasks"><p class="empty">No pending approvals.</p></div></section>
<section class="panel"><h2>Paired devices</h2><div id="devices" class="tasks"><p class="empty">No paired devices.</p></div></section>
<section class="panel"><h2>Local policies</h2><div id="policies"></div></section>
<section class="panel"><h2>Encrypted backup</h2><label>Backup passphrase<input id="passphrase" type="password" autocomplete="new-password" minlength="12"></label><div class="actions"><button id="export">Export</button><button class="secondary" id="import">Import pasted backup</button></div><label>Encrypted backup<textarea id="backup" placeholder="Encrypted Atlas backup JSON"></textarea></label></section>
<section><div class="section-title"><h2>Audit log</h2></div><div id="audit" class="tasks"><p class="empty">No audit events.</p></div></section>
</main><script type="module" src="/app.js"></script></body></html>`;

export const LOCAL_UI_CSS = `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#eff5ef;background:#0d120f;color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#24372b 0,transparent 35%),#0d120f;min-height:100vh}main{width:min(760px,calc(100% - 32px));margin:auto;padding:32px 0 72px}header,.section-title,.actions,.policy{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:clamp(2.4rem,8vw,4.6rem);line-height:.9;margin:5px 0 30px;letter-spacing:-.06em}h2{font-size:1.05rem;margin:0 0 18px}.eyebrow,.hint,time{font-size:.75rem;color:#9aafa0;letter-spacing:.12em}.panel,.task{border:1px solid #33443a;background:#141c17;border-radius:16px;padding:22px;margin:0 0 18px;box-shadow:0 20px 70px #0004}label{display:grid;gap:7px;margin:0 0 15px;color:#bfd0c3;font-size:.9rem}input,textarea,select,button{font:inherit;border-radius:9px}input,textarea,select{width:100%;border:1px solid #405247;background:#0d120f;color:#fff;padding:12px}textarea{min-height:110px;resize:vertical}button{border:0;background:#d8ff8f;color:#14200f;font-weight:750;padding:11px 16px;cursor:pointer}.secondary{background:#26352b;color:#dfe9e1}.hint,#notice,#pair-code{margin:12px 0}.tasks{display:grid;gap:12px}.task{margin:0}.task-top{display:flex;justify-content:space-between;gap:14px}.task h3{font-size:1rem;margin:0;overflow-wrap:anywhere}.task p{color:#b8c6bb;white-space:pre-wrap;overflow-wrap:anywhere}.status{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:#d8ff8f}.status.failed,.status.interrupted,.status.denied{color:#ffb0a7}.empty{color:#91a397}.policy{padding:10px 0;border-top:1px solid #29372f}.policy select{width:120px}.actions{justify-content:flex-start;margin-bottom:15px;flex-wrap:wrap}.transcript{display:grid;gap:9px;max-height:46vh;overflow-y:auto;border:1px solid #29372f;border-radius:12px;padding:13px;background:#0d120f;margin-bottom:15px}.line{display:grid;gap:3px}.line .who{font-size:.68rem;letter-spacing:.11em;text-transform:uppercase;color:#9aafa0}.line p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#e7efe8}.line.progress p{color:#9aafa0;font-size:.86rem}.line.failed p,.line.cancelled p{color:#ffb0a7}@media(max-width:560px){main{width:min(100% - 22px,760px);padding-top:20px}header{align-items:flex-start;flex-direction:column;gap:0}.panel,.task{padding:17px}}`;

export const LOCAL_UI_JS = `const q=s=>document.querySelector(s),tokenInput=q('#token'),tasks=q('#tasks'),notice=q('#notice');let knownApprovals=new Set;tokenInput.value=sessionStorage.getItem('atlas-token')||'';const headers=()=>({authorization:'Bearer '+sessionStorage.getItem('atlas-token')}),api=(url,options={})=>fetch(url,{...options,headers:{...headers(),...(options.headers||{})}});function esc(v){const d=document.createElement('div');d.textContent=v??'';return d.innerHTML}async function load(){const [tr,ar,pr,lr,dr]=await Promise.all(['/v1/tasks','/v1/approvals','/v1/policies','/v1/audit','/v1/devices'].map(u=>api(u)));if(tr.status===401){tasks.innerHTML='<p class="empty">Unlock this tab to load tasks.</p>';return}const list=(await tr.json()).tasks;tasks.innerHTML=list.length?list.map(t=>'<article class="task"><div class="task-top"><h3>'+esc(t.objective)+'</h3><span class="status '+t.status+'">'+t.status+'</span></div><p>'+esc(t.repository)+' · '+esc(t.model)+'</p>'+(t.message?'<p>'+esc(t.message)+'</p>':'')+'<time>'+new Date(t.createdAt).toLocaleString()+'</time></article>').join(''):'<p class="empty">No local tasks yet.</p>';const approvals=(await ar.json()).approvals,pending=approvals.filter(a=>a.status==='pending');if('Notification'in window&&Notification.permission==='granted')pending.filter(a=>!knownApprovals.has(a.id)).forEach(a=>new Notification('Atlas approval required',{body:a.capability+': '+a.summary,tag:a.id}));knownApprovals=new Set(pending.map(a=>a.id));q('#approvals').innerHTML=pending.map(a=>'<article class="task"><h3>'+esc(a.capability)+'</h3><p>'+esc(a.summary)+'</p><div class="actions"><button data-decision="approved" data-id="'+a.id+'">Approve</button><button class="secondary" data-decision="denied" data-id="'+a.id+'">Deny</button></div></article>').join('')||'<p class="empty">No pending approvals.</p>';q('#approvals').querySelectorAll('button').forEach(b=>b.onclick=()=>decide(b.dataset.id,b.dataset.decision));const policies=(await pr.json()).policies;q('#policies').innerHTML=policies.map(p=>'<div class="policy"><span>'+esc(p.capability)+'</span><select data-capability="'+esc(p.capability)+'"><option'+(p.decision==='allow'?' selected':'')+'>allow</option><option'+(p.decision==='ask'?' selected':'')+'>ask</option><option'+(p.decision==='deny'?' selected':'')+'>deny</option></select></div>').join('');q('#policies').querySelectorAll('select').forEach(s=>s.onchange=()=>api('/v1/policies',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({capability:s.dataset.capability,decision:s.value})}).then(load));const events=(await lr.json()).events;q('#audit').innerHTML=events.slice(0,50).map(e=>'<article class="task"><div class="task-top"><h3>'+esc(e.category)+'</h3><time>'+new Date(e.createdAt).toLocaleString()+'</time></div><p>'+esc(e.summary)+'</p></article>').join('')||'<p class="empty">No audit events.</p>';const devices=(await dr.json()).devices;q('#devices').innerHTML=devices.filter(d=>!d.revokedAt).map(d=>'<article class="task"><div class="task-top"><h3>'+esc(d.name)+'</h3><button class="secondary" data-device="'+d.id+'">Revoke</button></div><time>'+new Date(d.createdAt).toLocaleString()+'</time></article>').join('')||'<p class="empty">No paired devices.</p>';q('#devices').querySelectorAll('button').forEach(b=>b.onclick=()=>api('/v1/devices/'+b.dataset.device,{method:'DELETE'}).then(load))}async function decide(id,decision){await api('/v1/approvals/'+id+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision})});load()}async function models(){const r=await api('/v1/models');if(!r.ok)return;const v=await r.json();if(v.models.length)q('#model').innerHTML=v.models.map(m=>'<option>'+esc(m)+'</option>').join('')}q('#save-token').onclick=()=>{sessionStorage.setItem('atlas-token',tokenInput.value);load();models();loadSessions();if(sessionId)selectSession(sessionId)};q('#refresh').onclick=load;q('#notify').onclick=async()=>{if(!('Notification'in window))return notice.textContent='Notifications are unavailable in this browser.';const result=await Notification.requestPermission();notice.textContent=result==='granted'?'Approval notifications enabled.':'Notification permission was not granted.'};q('#task-form').onsubmit=async e=>{e.preventDefault();notice.textContent='Queueing…';const r=await api('/v1/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repository:q('#repository').value,objective:q('#objective').value,model:q('#model').value})});const data=await r.json();notice.textContent=r.ok?(data.approval?'Waiting for approval.':'Task queued in an isolated worktree.'):data.message;load()};q('#pair').onclick=async()=>{const r=await api('/v1/pair',{method:'POST'}),v=await r.json();q('#pair-code').textContent=r.ok?'Pairing code '+v.code+' expires '+new Date(v.expiresAt).toLocaleTimeString():v.message};q('#export').onclick=async()=>{const r=await api('/v1/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:q('#passphrase').value})}),v=await r.json();q('#backup').value=r.ok?JSON.stringify(v.backup):v.message};q('#import').onclick=async()=>{let backup;try{backup=JSON.parse(q('#backup').value)}catch{return notice.textContent='Backup JSON is invalid.'}const r=await api('/v1/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:q('#passphrase').value,backup})});notice.textContent=r.ok?'Backup imported.':'Import failed.';load()};fetch('/health').then(r=>r.json()).then(v=>q('#health').textContent=v.status==='ok'?v.model+' ready':'Unavailable').catch(()=>q('#health').textContent='Unavailable');if(tokenInput.value){load();models()}setInterval(()=>{if(sessionStorage.getItem('atlas-token'))load()},5000);
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
 q('#session-picker').innerHTML='<option value="">New session…</option>'+list.map(s=>'<option value="'+s.id+'"'+(s.id===sessionId?' selected':'')+'>'+esc(s.title)+' · '+esc(s.status)+'</option>').join('');
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
`;
