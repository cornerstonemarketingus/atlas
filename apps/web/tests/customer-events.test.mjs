import assert from "node:assert/strict";
import test from "node:test";
import { encodeEvent, createEventParser } from "../app/api/chat/stream.mjs";
const secret = "INTERNAL_BUILD_SENTINEL /srv/atlas/private.ts provider stack trace";
function event(type, data) { return createEventParser().push(encodeEvent(type, data)); }
test("public wire never carries reasoning, backend error bodies, tool previews or agent reports", () => {
  const wire = encodeEvent("thinking", { text: secret })
    + encodeEvent("error", { message: secret, stack: secret })
    + encodeEvent("tool", { id: "call_1", label: secret, state: "failed", preview: { content: secret }, arguments: secret })
    + encodeEvent("agent", { id: "a1", name: secret, title: secret, summary: secret, role: secret, state: "failed", depth: 0 })
    + encodeEvent("project", { operationId: "operation_1", status: "failed", message: secret, commit: secret, deploymentState: secret })
    + encodeEvent("internal-diagnostic", { text: secret });
  assert.equal(wire.includes(secret), false);
  const parser=createEventParser(); const events=[];
  for(let i=0;i<wire.length;i+=7) events.push(...parser.push(wire.slice(i,i+7)));
  assert.deepEqual(events.map(item=>item.type), ["error","tool","agent","project"]);
  assert.equal(events[1].data.state,"failed");
  assert.match(events[1].data.label,/attention/);
  assert.equal(events[2].data.name,"Atlas");
});
test("completion keeps the answer and recovery identity without backend metadata", () => {
  const [result]=event("done",{conversationId:"thread",stored:false,steps:[secret],servedBy:{endpoint:secret},finalization:{error:secret},reply:{id:"r1",role:"assistant",content:"Your website is ready to review.",createdAt:"now",debug:secret}});
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(result.data.reply.content,"Your website is ready to review.");
  assert.equal(result.data.stored,false);
  assert.equal(result.data.conversationId,"thread");
});
test("approval status stays visible and arbitrary provider fields are discarded",()=>{
 const [result]=event("project",{operationId:"operation_1",status:"awaiting-approval",approvalId:"approval_1",message:secret,credentials:secret});
 assert.equal(result.data.approvalId,"approval_1");
 assert.match(result.data.message,/approval/);
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.deepEqual(event("delta",{text:"Hello",reasoning:secret}),[{type:"delta",data:{text:"Hello"}}]);
});

test("published project links survive filtering while untrusted redirects do not",()=>{
 const [published]=event("project",{status:"published",operationId:"op",repository:{fullName:"customer/website",webUrl:"https://github.com/customer/website"}});
 assert.equal(published.data.repository.webUrl,"https://github.com/customer/website");
 for(const webUrl of ["javascript:alert(1)","https://internal.example/private","https://github.com/customer/website?token=secret"]){
  const [result]=event("project",{status:"published",repository:{fullName:"customer/website",webUrl}});assert.equal(result.data.repository,undefined);
 }
});

test("customer model context excludes Atlas architecture and credential deployment instructions", async()=>{
 const {atlasSystemPrompt}=await import("../app/api/chat/atlas-knowledge.mjs");
 for(const input of [{},{isOwner:false,repository:"customer/site",projectCapabilities:{reason:"INTERNAL_BUILD_SENTINEL"}}]){
  const prompt=atlasSystemPrompt(input);
  for(const internal of ["apps/web","apps/local-control","node:sqlite","ATLAS_GITHUB_TOKEN","ATLAS_GITHUB_APP_","Cloudflare Worker secret","INTERNAL_BUILD_SENTINEL"]){assert.equal(prompt.includes(internal),false,internal);}
  assert.match(prompt,/private|internal/);
 }
 const owner=atlasSystemPrompt({isOwner:true});assert.match(owner,/apps\/web/);assert.match(owner,/ATLAS_GITHUB_TOKEN/);
});
