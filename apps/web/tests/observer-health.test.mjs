import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { dispatchSavedTask } from "../app/api/tasks/durable-dispatch.mjs";
import { grantTaskExecution } from "../app/api/tasks/execution-claims.mjs";
import { configureObservation, observationCandidates, reserveObservation, OBSERVATION_POLICY as P } from "../app/api/tasks/outcome-observer.mjs";
import { observerResponseFailure, observerProviderState, recordProviderCooldown, observationHealth, safeObserverFailure } from "../app/api/tasks/observer-health.mjs";
import { scheduledOutcomeObservation } from "../worker/outcome-observer.mjs";
import { observationHealthExplanation } from "../app/build/request-inspection-client.mjs";
const now = Date.now();
const scope = { tenantId: 1, principal: "operator" };
const idFor = n => `${n.toString(16).padStart(8,"0")}-1111-4111-8111-111111111111`;
async function fixture(t, count = 1) {
  const f = migratedDatabase(); t.after(() => f.sqlite.close()); const tasks = [];
  for (let n = 1; n <= count; n++) {
    const task = { taskId: idFor(n), tenantId: 1, requestedBy: "operator", repository: "cornerstonemarketingus/atlas", branch: "main", mode: "coder", objective: "Fix tests", mergePolicy: "manual", correlationId: `cor_${idFor(n).replaceAll("-","")}`, conversationId: `cooldown-${n}`, executionProvider: "managed", dispatchState: "dispatched", githubRunId: null };
    await dispatchSavedTask(f.d1, { ...task, account: { userId: "operator", dbUserId: null }, task }, async () => new Response(null, { status: 204 }));
    f.sqlite.prepare("INSERT INTO task_requests (tenant_id,requested_by,request_key,fingerprint,correlation_id,state) VALUES (1,'operator',?,?,?,'reserved')").run(task.taskId,"a".repeat(64),task.correlationId);
    await grantTaskExecution(f.d1, task, { run_id: String(100+n), run_attempt: "1" },new Date(now-2*P.lifetimeMs));
    await configureObservation(f.d1,scope,task.taskId,null,true,now); tasks.push(task);
  }
  return { ...f,tasks };
}

test("rate headers reuse native GitHub parsing and honor the longest valid wait", () => {
  const response = (status,headers) => new Response("private provider body",{status,headers});
  assert.equal(observerResponseFailure(response(429,{"retry-after":"7200","x-ratelimit-remaining":"0","x-ratelimit-reset":String(Math.floor(now/1000)+10800)}),0,now).retryAt, (Math.floor(now/1000)+10800)*1000);
  assert.equal(observerResponseFailure(response(503,{"retry-after":new Date(now+3600000).toUTCString()}),0,now).retryAt, Math.floor((now+3600000)/1000)*1000);
  assert.equal(observerResponseFailure(response(403,{"x-ratelimit-remaining":"0"}),0,now).category,"rate_limit");
  assert.equal(observerResponseFailure(response(403,{}),0,now).category,"permission");
  assert.equal(observerResponseFailure(response(401,{}),0,now).category,"authentication");
  assert.equal(observerResponseFailure(response(404,{}),0,now).shared,false);
  assert.equal(observerResponseFailure(response(200,{}),0,now),null);
  assert.equal(observerResponseFailure(response(200,{"x-ratelimit-remaining":"0","x-ratelimit-reset":String(Math.floor(now/1000)+3600)}),0,now).category,"rate_limit");
  assert.equal(observerResponseFailure(response(429,{}),3,now).retryAt,now+480000);
  const malformed=observerResponseFailure(response(429,{"retry-after":"private-token","x-ratelimit-reset":"not-a-number"}),0,now);
  assert.equal(malformed.retryAt,now+60000); assert.doesNotMatch(JSON.stringify(malformed),/private/);
  assert.deepEqual(safeObserverFailure({observerFailure:{category:"private",retryAt:Infinity}},now),{category:"unavailable",retryAt:now+900000});
});

test("durable provider pauses cannot be shortened and gate both selection and reservation", async t => {
  const f=await fixture(t); const task=f.tasks[0];
  await recordProviderCooldown(f.d1,{category:"rate_limit",retryAt:now+3600000,shared:true},now);
  await recordProviderCooldown(f.d1,{category:"unavailable",retryAt:now+60000,shared:true},now+1);
  const saved=await observerProviderState(f.d1); assert.equal(saved.retryAt,now+3600000); assert.equal(saved.category,"rate_limit"); assert.equal(saved.failures,2);
  assert.deepEqual(await observationCandidates(f.d1,now),[]);
  assert.equal(await reserveObservation(f.d1,{taskId:task.taskId,...scope,requestKey:task.taskId},now),null);
  assert.equal((await observationCandidates(f.d1,now+3600001)).length,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_outcome_observations").get().n,0);
});

test("rate refusal stops a tick, persists across runtime replacement, and preserves budgets", async t => {
  const f=await fixture(t,2); let calls=0;
  const fetcher=async()=>{calls++;return new Response("private-rate-provider-body",{status:429,headers:{"retry-after":"7200"}});};
  const first=await scheduledOutcomeObservation({DB:f.d1,ATLAS_GITHUB_TOKEN:"fake-cooldown-token"},fetcher);
  assert.equal(first.reserved,1); assert.equal(calls,1);
  const ledger=f.sqlite.prepare("SELECT status,reason,retry_at FROM task_outcome_observations").get();
  assert.equal(ledger.status,"unavailable"); assert.equal(ledger.reason,"rate_limit"); assert.ok(ledger.retry_at>=now+7200000);
  const second=await scheduledOutcomeObservation({DB:f.d1,ATLAS_GITHUB_TOKEN:"fake-cooldown-token"},()=>assert.fail("No request during durable cooldown"));
  assert.equal(second.reserved,0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_outcome_observations").get().n,1);
  const health=await observationHealth(f.d1,scope,f.tasks[0].taskId);
  assert.equal(health.state,"provider_cooldown"); assert.equal(health.reason,"rate_limit"); assert.ok(health.eligibleAfter);
  assert.doesNotMatch(JSON.stringify(health),/private-rate|fake-cooldown/);
});

test("successful quota-exhaustion headers prevent the next metadata read", async t => {
  const f=await fixture(t); let calls=0;
  await scheduledOutcomeObservation({DB:f.d1,ATLAS_GITHUB_TOKEN:"fake"},async()=>{
    calls++;return Response.json({id:101,run_attempt:1,event:"workflow_dispatch",head_branch:"main",head_sha:"a".repeat(40),path:".github/workflows/atlas-coder.yml",display_title:`Atlas Coder · task ${f.tasks[0].taskId}`,repository:{id:1337761549,full_name:"cornerstonemarketingus/atlas"}},{headers:{"x-ratelimit-remaining":"0","x-ratelimit-reset":String(Math.floor(Date.now()/1000)+3600)}});
  });
  assert.equal(calls,1); assert.equal((await observerProviderState(f.d1)).category,"rate_limit");
});

test("health remains scoped, distinguishes expired/exhausted/uncertain checks, and discloses no other records", async t => {
  const f=await fixture(t); const task=f.tasks[0];
  assert.equal(await observationHealth(f.d1,{tenantId:2,principal:"operator"},task.taskId,now),null);
  assert.equal(await observationHealth(f.d1,{tenantId:1,principal:"foreign"},task.taskId,now),null);
  assert.equal((await observationHealth(f.d1,scope,task.taskId,now)).state,"scheduled");
  await reserveObservation(f.d1,{taskId:task.taskId,...scope,requestKey:task.taskId},now);
  const uncertain=await observationHealth(f.d1,scope,task.taskId,now); assert.equal(uncertain.state,"unconfirmed_reservation"); assert.equal(uncertain.lastStatus,"reserved");
  assert.equal((await observationHealth(f.d1,scope,task.taskId,now+P.lifetimeMs)).state,"expired");
  const insert=f.sqlite.prepare("INSERT INTO task_outcome_observations (task_id,tenant_id,requested_by,run_id,run_attempt,slot,day,status,started_at) VALUES (?,1,'operator',101,1,?,?,'unavailable',?)");
  for(let i=1;i<8;i++) insert.run(task.taskId,Math.floor(now/P.intervalMs)-i,Math.floor(now/86400000),now-i*P.intervalMs);
  assert.equal((await observationHealth(f.d1,scope,task.taskId,now)).state,"exhausted");
  await configureObservation(f.d1,scope,task.taskId,null,false,now+1);
  assert.equal((await observationHealth(f.d1,scope,task.taskId,now+2)).state,"stopped");
  assert.doesNotMatch(observationHealthExplanation({state:"private-message",reason:"secret"}),/private|secret/);
  assert.match(observationHealthExplanation({state:"provider_cooldown",reason:"authentication"}),/operator attention/);
  assert.match(observationHealthExplanation(uncertain),/unconfirmed|no completion receipt/);
});

test("built Worker exposes only scoped provider health and fails closed without its migration", async t => {
  const f=await fixture(t);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier,context,next){if(specifier==="cloudflare:workers")return {url:"data:text/javascript,export const env=globalThis.__healthEnv; export class DurableObject {}",shortCircuit:true};return next(specifier,context);}`)}`,import.meta.url);
  globalThis.__healthEnv={DB:f.d1}; const old=process.env.ATLAS_OPERATOR_TOKEN; process.env.ATLAS_OPERATOR_TOKEN="health-owner";
  t.after(()=>{delete globalThis.__healthEnv;if(old===undefined)delete process.env.ATLAS_OPERATOR_TOKEN;else process.env.ATLAS_OPERATOR_TOKEN=old;});
  await recordProviderCooldown(f.d1,{category:"permission",retryAt:now+3600000,shared:true},now);
  const {default:worker}=await import(new URL("../dist/server/index.js",import.meta.url));
  const invoke=token=>worker.fetch(new Request(`https://atlas.test/api/tasks/requests/${f.tasks[0].taskId}`,{headers:{authorization:`Bearer ${token}`}}),globalThis.__healthEnv,{waitUntil(){},passThroughOnException(){}});
  assert.equal((await invoke("wrong")).status,401);
  const response=await invoke("health-owner");assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get("cache-control"),"no-store");
  const body=await response.json();assert.equal(body.request.task.execution.observation.health.state,"provider_cooldown");assert.equal(body.request.task.execution.observation.health.reason,"permission");
  f.sqlite.exec("DROP TABLE task_observer_provider_state");const unavailable=await invoke("health-owner");assert.equal(unavailable.status,503);assert.doesNotMatch(await unavailable.text(),/SQL|no such table|health-owner/);
});

test("missing credentials pause without network, while a missing run backs off only its watch",async t=>{
  const missing=await fixture(t); let calls=0;
  await scheduledOutcomeObservation({DB:missing.d1},()=>{calls++;assert.fail("No missing-credential requests");});
  assert.equal(calls,0);assert.equal((await observerProviderState(missing.d1)).category,"authentication");
  const absent=await fixture(t);
  await scheduledOutcomeObservation({DB:absent.d1,ATLAS_GITHUB_TOKEN:"fake"},async()=>new Response("private missing resource",{status:404}));
  assert.equal(await observerProviderState(absent.d1),null);
  const health=await observationHealth(absent.d1,scope,absent.tasks[0].taskId);
  assert.equal(health.state,"check_backoff");assert.equal(health.reason,"not_found");
});

test("a full history page shares health reads and does not expose aggregate counts",async t=>{
  const f=await fixture(t,20);const {listTaskRequests}=await import("../app/api/tasks/request-inspection.mjs");
  let reads=0;const d1={...f.d1,prepare:sql=>{reads++;return f.d1.prepare(sql);}};
  const page=await listTaskRequests(d1,scope);
  assert.equal(page.requests.length,20);assert.equal(reads,23);
  for(const request of page.requests){assert.equal(request.task.execution.observation.health.state,"scheduled");assert.doesNotMatch(JSON.stringify(request.task.execution.observation.health),/tenant|total|failures/);}
});
