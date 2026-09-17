"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AtlasMark } from "./AtlasMark.js";

type Task = { taskId:string; conversationId?:string|null; objective:string; repository:string; branch:string; mode:string; status:string; createdAt:string; pullRequest?:{url:string|null;number:number;merged:boolean}|null };
type Conversation = { id:string; title:string; repository:string; branch:string; updatedAt:string };
type ConversationDetail = { tasks:Array<{ taskId:string; objective:string; repository:string; branch:string; mode:string; createdAt:string; executionProvider:string }> };
type Props = {
  repository:string; repositories:string[]; branch:string; branches:string[]; defaultBranch:string; mode:string; objective:string; submitting:boolean; notice:string;
  tasks:Task[]; accountLabel:string; connected:boolean|null;
  conversationId:string|null; onConversation:(value:string|null)=>void;
  onRepository:(value:string)=>void; onBranch:(value:string)=>void; onMode:(value:string)=>void; onObjective:(value:string)=>void; onSubmit:(event:FormEvent)=>void; onSignOut:()=>void;
};

const progress:Record<string,string[]>={dispatched:["Request received","Preparing a private workspace"],queued:["Request received","Waiting for secure compute"],running:["Understanding your project","Working through the requested change","Validation will run next"],succeeded:["Project understood","Change completed","Validation passed"],failed:["Project understood","Work stopped during validation"]};

export function AtlasWorkspace(props:Props){
  const [listening,setListening]=useState(false),[attachments,setAttachments]=useState<{name:string;url:string}[]>([]),[fresh,setFresh]=useState(false),fileRef=useRef<HTMLInputElement>(null);
  const [conversations,setConversations]=useState<Conversation[]>([]),[selectedTasks,setSelectedTasks]=useState<Task[]|null>(null),[panelTab,setPanelTab]=useState<"activity"|"changes"|"preview">("activity"),[panelOpen,setPanelOpen]=useState(true),[sidebarOpen,setSidebarOpen]=useState(false);
  useEffect(()=>{let active=true;void fetch("/api/conversations").then(response=>response.ok?response.json():null).then((value:{conversations?:Conversation[]}|null)=>{if(active&&value?.conversations)setConversations(value.conversations)}).catch(()=>undefined);return()=>{active=false}},[props.tasks]);
  async function selectConversation(id:string){
    props.onConversation(id);setFresh(false);setSidebarOpen(false);
    try{const response=await fetch(`/api/conversations/${encodeURIComponent(id)}`);if(!response.ok)return;const value=await response.json() as ConversationDetail;const live=new Map(props.tasks.map(task=>[task.taskId,task]));setSelectedTasks(value.tasks.map(task=>live.get(task.taskId)??{...task,status:"dispatched"}));}catch{/* Keep the current view when history is temporarily unavailable. */}
  }
  async function closeConversation(id:string){
    const response=await fetch(`/api/conversations/${encodeURIComponent(id)}`,{method:"DELETE"}).catch(()=>null);if(!response?.ok)return;
    setConversations(items=>items.filter(item=>item.id!==id));
    if(props.conversationId===id){props.onConversation(null);setSelectedTasks(null);setFresh(true)}
  }
  function dictate(){
    type Recognition={lang:string;interimResults:boolean;start:()=>void;onresult:(event:{results:ArrayLike<{0:{transcript:string}}>} )=>void;onend:()=>void;onerror:()=>void};
    const Speech=(window as unknown as {webkitSpeechRecognition?:new()=>Recognition;SpeechRecognition?:new()=>Recognition}).SpeechRecognition??(window as unknown as {webkitSpeechRecognition?:new()=>Recognition}).webkitSpeechRecognition;
    if(!Speech){props.onObjective(`${props.objective}${props.objective?" ":""}[Voice input is unavailable in this browser]`);return}
    const recognition=new Speech();recognition.lang="en-US";recognition.interimResults=false;recognition.onresult=e=>props.onObjective(`${props.objective}${props.objective?" ":""}${e.results[0][0].transcript}`);recognition.onend=()=>setListening(false);recognition.onerror=()=>setListening(false);setListening(true);recognition.start();
  }
  function pick(files:FileList|null){if(!files)return;setAttachments(current=>[...current,...[...files].slice(0,4-current.length).map(file=>({name:file.name,url:URL.createObjectURL(file)}))])}
  const current=fresh?undefined:(selectedTasks?.at(-1)??props.tasks.find(task=>task.conversationId===props.conversationId)??props.tasks[0]);
  function submit(event:FormEvent){setFresh(false);setAttachments([]);props.onSubmit(event)}
  return <main className={`atlas-workspace ${panelOpen?"":"panel-closed"}`}>
    {sidebarOpen&&<button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}/>}
    <aside className={`workspace-sidebar ${sidebarOpen?"open":""}`}>
      <div className="sidebar-brand-row"><Link className="workspace-brand" href="/"><span><AtlasMark/></span>ATLAS</Link><button className="sidebar-close" aria-label="Close navigation" onClick={()=>setSidebarOpen(false)}>×</button></div>
      <button className="new-thread" onClick={()=>{props.onObjective("");props.onConversation(null);setSelectedTasks(null);setAttachments([]);setFresh(true);setSidebarOpen(false)}}><b>＋</b> New conversation</button>
      <p className="sidebar-label">Recent</p>
      <div className="thread-list">{conversations.map(item=><div className={item.id===props.conversationId?"active":""} key={item.id}><button className="thread-open" onClick={()=>void selectConversation(item.id)}><span>{item.title}</span><small>{item.repository}</small></button><button className="thread-close" aria-label={`Close ${item.title}`} title="Close conversation" onClick={()=>void closeConversation(item.id)}>×</button></div>)}{!conversations.length&&props.tasks.slice(0,8).map((task,index)=><div className={index===0&&!fresh?"active":""} key={task.taskId}><button className="thread-open" onClick={()=>{setSelectedTasks([task]);setFresh(false);setSidebarOpen(false)}}><span>{task.objective}</span><small>{task.repository}</small></button></div>)}</div>
      <div className="sidebar-bottom"><a href="/computer">Computer control</a><a href="/setup">Connections</a><a href="/account">Settings</a><button onClick={props.onSignOut}>Sign out · {props.accountLabel}</button></div>
    </aside>
    <section className="conversation-shell">
      <header className="workspace-header"><div className="header-leading"><button className="mobile-menu" aria-label="Open navigation" onClick={()=>setSidebarOpen(true)}>☰</button><span><span className="privacy-dot"/>Private workspace</span></div><div className="workspace-context"><span>{props.repository}</span><span>{props.branch}</span>{!panelOpen&&<button className="panel-reopen" onClick={()=>setPanelOpen(true)}>View work</button>}</div></header>
      <div className="conversation-scroll">
        {!current&&<div className="workspace-empty"><div className="empty-mark"><AtlasMark/></div><p className="kicker">BUILD WITH ATLAS</p><h1>What will we make?</h1><p>Describe an outcome. Atlas will understand the project, do the work, validate it, and keep you in control.</p><div className="starter-grid"><button onClick={()=>props.onObjective("Build a polished onboarding experience for new users")}>Design an onboarding flow<span>Product & interface</span></button><button onClick={()=>props.onObjective("Investigate the application and recommend the highest-impact improvement")}>Find the next improvement<span>Research & planning</span></button><button onClick={()=>props.onObjective("Diagnose the current failing tests and fix the root cause")}>Fix what’s broken<span>Debug & validate</span></button></div></div>}
        {current&&<div className="message-stream">
          <div className="user-message"><p>{current.objective}</p></div>
          <div className="atlas-message"><div className="assistant-avatar"><AtlasMark/></div><div><b>Atlas</b><p>{current.status==="succeeded"?"The work is complete and the result passed validation.":current.status==="failed"?"I stopped because the result did not pass its safety or validation checks.":"I’m working through this now. You can follow the meaningful steps as they happen."}</p><div className="work-trace">{(progress[current.status]??progress.dispatched).map((item,index)=><div className={index===(progress[current.status]??progress.dispatched).length-1&&!["succeeded","failed"].includes(current.status)?"working":"done"} key={item}><i/>{item}</div>)}</div>{current.pullRequest?.url&&<a className="result-link" href={current.pullRequest.url} target="_blank" rel="noreferrer">Review the completed change ↗</a>}</div></div>
        </div>}
      </div>
      <form className="chat-composer" onSubmit={submit}>
        {attachments.length>0&&<div className="attachment-row">{attachments.map((item,index)=><div key={item.url}><span className="attachment-preview" style={{backgroundImage:`url(${item.url})`}}/><span>{item.name}</span><button type="button" onClick={()=>setAttachments(items=>items.filter((_,i)=>i!==index))}>×</button></div>)}</div>}
        <textarea aria-label="Message Atlas" value={props.objective} onChange={event=>props.onObjective(event.target.value)} placeholder="Ask Atlas to build, change, investigate, or operate something…" rows={3}/>
        <div className="composer-actions"><div><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event=>pick(event.target.files)}/><button type="button" title="Add images" onClick={()=>fileRef.current?.click()}>＋</button><button type="button" title="Dictate" className={listening?"listening":""} onClick={dictate}>⌁</button><select aria-label="Build mode" value={props.mode} onChange={event=>props.onMode(event.target.value)}><option value="inspect">Plan</option><option value="debug">Debug</option><option value="coder">Build</option></select></div><button className="send" disabled={props.submitting||!props.objective.trim()||props.connected===false}>{props.submitting?"…":"↑"}</button></div>
        <div className="composer-context"><label>Project<select value={props.repository} onChange={event=>props.onRepository(event.target.value)}>{props.repositories.map(value=><option key={value}>{value}</option>)}</select></label><label>Branch<select value={props.branch} onChange={event=>props.onBranch(event.target.value)}>{props.branches.map(value=><option key={value}>{value}{value===props.defaultBranch?" · default":""}</option>)}</select></label><span>{attachments.length?"Images are staged; private vision runtime connection required":"Atlas can make mistakes. Review consequential actions."}</span></div>
        {props.notice&&<p className="composer-notice" role="status">{props.notice}</p>}
      </form>
    </section>
    {panelOpen&&<aside className="workspace-panel"><div className="panel-tabs" role="tablist" aria-label="Work details"><button className={panelTab==="activity"?"active":""} role="tab" aria-selected={panelTab==="activity"} onClick={()=>setPanelTab("activity")}>Activity</button><button className={panelTab==="changes"?"active":""} role="tab" aria-selected={panelTab==="changes"} onClick={()=>setPanelTab("changes")}>Changes</button><button className={panelTab==="preview"?"active":""} role="tab" aria-selected={panelTab==="preview"} onClick={()=>setPanelTab("preview")}>Preview</button><button className="panel-close" aria-label="Close work panel" title="Close panel" onClick={()=>setPanelOpen(false)}>×</button></div>{current?<><div className="run-summary"><span className={`run-state ${current.status}`}>{current.status}</span><h2>{current.objective}</h2><p>{current.repository}<br/>{current.branch}</p></div>{panelTab==="activity"&&<div className="panel-section" role="tabpanel"><small>LIVE WORK</small>{(progress[current.status]??progress.dispatched).map(item=><div className="panel-event" key={item}><i/>{item}</div>)}</div>}{panelTab==="changes"&&<div className="panel-empty compact" role="tabpanel"><span>±</span><h2>{current.pullRequest?.url?"Changes are ready":"No reviewable changes yet"}</h2><p>{current.pullRequest?.url?"Open the completed review to inspect every file and validation result.":"Atlas will place file changes here after the build produces a reviewable result."}</p>{current.pullRequest?.url&&<a className="result-link" href={current.pullRequest.url} target="_blank" rel="noreferrer">Open review ↗</a>}</div>}{panelTab==="preview"&&<div className="panel-empty compact" role="tabpanel"><span>◇</span><h2>Preview follows the build</h2><p>A safe interactive preview will appear here when this run reports one. Atlas will never invent a preview URL.</p></div>}</>:<div className="panel-empty"><span>◌</span><h2>Your work will appear here</h2><p>Files, previews, validation, and approvals stay beside the conversation.</p></div>}</aside>}
  </main>
}
