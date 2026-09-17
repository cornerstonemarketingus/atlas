"use client";
import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { AtlasMark } from "./AtlasMark.js";

type Task = { taskId:string; objective:string; repository:string; branch:string; mode:string; status:string; createdAt:string; pullRequest?:{url:string|null;number:number;merged:boolean}|null };
type Props = {
  repository:string; repositories:string[]; branch:string; branches:string[]; defaultBranch:string; mode:string; objective:string; submitting:boolean; notice:string;
  tasks:Task[]; accountLabel:string; connected:boolean|null;
  onRepository:(value:string)=>void; onBranch:(value:string)=>void; onMode:(value:string)=>void; onObjective:(value:string)=>void; onSubmit:(event:FormEvent)=>void; onSignOut:()=>void;
};

const progress:Record<string,string[]>={dispatched:["Request received","Preparing a private workspace"],queued:["Request received","Waiting for secure compute"],running:["Understanding your project","Working through the requested change","Validation will run next"],succeeded:["Project understood","Change completed","Validation passed"],failed:["Project understood","Work stopped during validation"]};

export function AtlasWorkspace(props:Props){
  const [listening,setListening]=useState(false),[attachments,setAttachments]=useState<{name:string;url:string}[]>([]),[fresh,setFresh]=useState(false),fileRef=useRef<HTMLInputElement>(null);
  function dictate(){
    type Recognition={lang:string;interimResults:boolean;start:()=>void;onresult:(event:{results:ArrayLike<{0:{transcript:string}}>} )=>void;onend:()=>void;onerror:()=>void};
    const Speech=(window as unknown as {webkitSpeechRecognition?:new()=>Recognition;SpeechRecognition?:new()=>Recognition}).SpeechRecognition??(window as unknown as {webkitSpeechRecognition?:new()=>Recognition}).webkitSpeechRecognition;
    if(!Speech){props.onObjective(`${props.objective}${props.objective?" ":""}[Voice input is unavailable in this browser]`);return}
    const recognition=new Speech();recognition.lang="en-US";recognition.interimResults=false;recognition.onresult=e=>props.onObjective(`${props.objective}${props.objective?" ":""}${e.results[0][0].transcript}`);recognition.onend=()=>setListening(false);recognition.onerror=()=>setListening(false);setListening(true);recognition.start();
  }
  function pick(files:FileList|null){if(!files)return;setAttachments(current=>[...current,...[...files].slice(0,4-current.length).map(file=>({name:file.name,url:URL.createObjectURL(file)}))])}
  const current=fresh?undefined:props.tasks[0];
  function submit(event:FormEvent){setFresh(false);setAttachments([]);props.onSubmit(event)}
  return <main className="atlas-workspace">
    <aside className="workspace-sidebar">
      <Link className="workspace-brand" href="/"><span><AtlasMark/></span>ATLAS</Link>
      <button className="new-thread" onClick={()=>{props.onObjective("");setAttachments([]);setFresh(true)}}><b>＋</b> New conversation</button>
      <p className="sidebar-label">Recent</p>
      <div className="thread-list">{props.tasks.slice(0,8).map((task,index)=><button className={index===0?"active":""} key={task.taskId}><span>{task.objective}</span><small>{task.repository}</small></button>)}</div>
      <div className="sidebar-bottom"><a href="/computer">Computer control</a><a href="/setup">Connections</a><a href="/account">Settings</a><button onClick={props.onSignOut}>Sign out · {props.accountLabel}</button></div>
    </aside>
    <section className="conversation-shell">
      <header className="workspace-header"><div><span className="privacy-dot"/>Private workspace</div><div className="workspace-context"><span>{props.repository}</span><span>{props.branch}</span></div></header>
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
    <aside className="workspace-panel"><div className="panel-tabs"><button className="active">Activity</button><button>Changes</button><button>Preview</button></div>{current?<><div className="run-summary"><span className={`run-state ${current.status}`}>{current.status}</span><h2>{current.objective}</h2><p>{current.repository}<br/>{current.branch}</p></div><div className="panel-section"><small>LIVE WORK</small>{(progress[current.status]??progress.dispatched).map(item=><div className="panel-event" key={item}><i/>{item}</div>)}</div></>:<div className="panel-empty"><span>◌</span><h2>Your work will appear here</h2><p>Files, previews, validation, and approvals stay beside the conversation.</p></div>}</aside>
  </main>
}
