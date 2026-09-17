import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createLocalControlServer } from "../src/server.mjs";
import { runIsolatedLocalCoder } from "../src/runner.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { decryptBackup, encryptBackup } from "../src/encrypted-backup.mjs";
import { verifyOfflineLicense } from "../src/offline-license.mjs";
import { buildRequest, publishChange } from "../src/publish-adapters.mjs";
import { discoverLocalModels } from "../src/model-discovery.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("local control plane authenticates, persists, and completes tasks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-control-"));
  const store = new LocalTaskStore(join(directory, "test.sqlite"));
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "verified locally" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const admin = { authorization: `Bearer ${TOKEN}` };

  assert.equal((await fetch(`${origin}/health`)).status, 200);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Atlas Local/u);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.equal((await fetch(`${origin}/v1/tasks`)).status, 401);
  await fetch(`${origin}/v1/policies`, { method: "PUT", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify({ capability: "code.write", decision: "allow" }) });
  const created = await fetch(`${origin}/v1/tasks`, {
    method: "POST", headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ repository: directory, objective: "Document sovereign mode." }),
  });
  assert.equal(created.status, 202);
  const { task } = await created.json();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fetched = await fetch(`${origin}/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).task.status, "completed");
  assert.equal(store.list()[0].message, "verified locally");
});

test("approval policy and phone pairing use separate revocable credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-pair-")); const store = new LocalTaskStore(join(directory,"test.sqlite"));
  const server = createLocalControlServer({store,token:TOKEN,runTask:async()=>({ok:true,message:"done"})}); await new Promise(r=>server.listen(0,"127.0.0.1",r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();await rm(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`, admin={authorization:`Bearer ${TOKEN}`};
  const created=await fetch(`${origin}/v1/tasks`,{method:"POST",headers:{...admin,"content-type":"application/json"},body:JSON.stringify({repository:directory,objective:"Needs approval"})});
  const payload=await created.json(); assert.equal(payload.task.status,"awaiting_approval"); assert.equal(payload.approval.status,"pending");
  const pair=await fetch(`${origin}/v1/pair`,{method:"POST",headers:admin}); const {code}=await pair.json();
  const claim=await fetch(`${origin}/v1/pair/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code,name:"Test phone"})});
  assert.equal(claim.status,201); const {deviceToken}=await claim.json(); assert.notEqual(deviceToken,TOKEN);
  const decision=await fetch(`${origin}/v1/approvals/${payload.approval.id}/decision`,{method:"POST",headers:{authorization:`Bearer ${deviceToken}`,"content-type":"application/json"},body:JSON.stringify({decision:"approved"})});
  assert.equal(decision.status,200); await new Promise(r=>setTimeout(r,20)); assert.equal(store.get(payload.task.id).status,"completed");
  const devices=await (await fetch(`${origin}/v1/devices`,{headers:admin})).json(); assert.equal(devices.devices.length,1);
  assert.equal((await fetch(`${origin}/v1/devices/${devices.devices[0].id}`,{method:"DELETE",headers:admin})).status,200);
  assert.equal((await fetch(`${origin}/v1/approvals`,{headers:{authorization:`Bearer ${deviceToken}`}})).status,401);
  const reuse=await fetch(`${origin}/v1/pair/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code,name:"Replay"})}); assert.equal(reuse.status,401);
});

test("backups are authenticated and encrypted", () => {
  const source={version:1,policies:[{capability:"code.write",decision:"ask"}]}; const backup=encryptBackup(source,"correct horse battery staple");
  assert.equal(JSON.stringify(backup).includes("code.write"),false); assert.deepEqual(decryptBackup(backup,"correct horse battery staple"),source);
  assert.throws(()=>decryptBackup(backup,"wrong passphrase value"),/authentication failed/u);
});

test("encrypted snapshots restore tasks, approvals, policies, and audit history", async (t) => {
  const directory=await mkdtemp(join(tmpdir(),"atlas-local-import-")); const source=new LocalTaskStore(join(directory,"source.sqlite")),target=new LocalTaskStore(join(directory,"target.sqlite"));
  t.after(async()=>{source.close();target.close();await rm(directory,{recursive:true,force:true});});
  const task=source.create({repository:directory,objective:"restore me",model:"local"}); source.createApproval({taskId:task.id,capability:"code.write",summary:"restore approval"}); source.setPolicy("code.write","deny");
  target.importSnapshot(source.snapshot()); assert.equal(target.get(task.id).objective,"restore me"); assert.equal(target.approvals().length,1); assert.equal(target.policy("code.write").decision,"deny"); assert.ok(target.auditEvents().some(e=>e.category==="backup.imported"));
});

test("local model discovery normalizes OpenAI-compatible model lists", async () => {
  const result=await discoverLocalModels({fetchImpl:async()=>new Response(JSON.stringify({data:[{id:"qwen2.5-coder:7b"},{id:"qwen2.5-coder:7b"},{id:"deepseek-coder"}]}),{status:200})});
  assert.deepEqual(result.models,["deepseek-coder","qwen2.5-coder:7b"]); await assert.rejects(discoverLocalModels({endpoint:"http://remote.example/v1"}),/requires HTTPS/u);
});

test("offline licenses require a valid Ed25519 signature and current expiry", () => {
  const {publicKey,privateKey}=generateKeyPairSync("ed25519"); const payload=Buffer.from(JSON.stringify({licenseId:"lic_1",tier:"pro",expiresAt:"2030-01-01T00:00:00.000Z"})).toString("base64url");
  const document={payload,signature:sign(null,Buffer.from(payload),privateKey).toString("base64url")}; assert.equal(verifyOfflineLicense(document,publicKey,new Date("2029-01-01")).valid,true);
  assert.equal(verifyOfflineLicense({...document,signature:"bad"},publicKey).valid,false); assert.equal(verifyOfflineLicense(document,publicKey,new Date("2031-01-01")).reason,"expired");
});

test("publishing adapters keep credentials in headers and support three Git hosts", async () => {
  const base={worktree:"/repo",branch:"atlas/task",owner:"acme",repository:"widget",title:"Change",body:"Body",token:"secret",targetBranch:"main"};
  for (const [provider,baseUrl,header] of [["github","https://api.github.com","authorization"],["gitlab","https://gitlab.example","private-token"],["forgejo","https://git.example","authorization"]]) {
    const request=buildRequest({...base,provider,baseUrl}); assert.equal(request.url.toString().includes("secret"),false); assert.ok(request.options.headers[header]);
  }
  const calls=[]; const result=await publishChange({...base,provider:"github",baseUrl:"https://api.github.com"},{push:async()=>({ok:true,message:"pushed"}),fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({number:7,html_url:"https://example/pr/7"}),{status:201});}});
  assert.deepEqual(result,{ok:true,url:"https://example/pr/7",number:7}); assert.equal(calls.length,1);
  assert.throws(()=>buildRequest({...base,provider:"forgejo",baseUrl:"http://remote.example"}),/require HTTPS/u);
});

test("running tasks are marked interrupted after a restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-restart-"));
  const filename = join(directory, "test.sqlite");
  const first = new LocalTaskStore(filename);
  const task = first.create({ repository: directory, objective: "test", model: "local" });
  first.markRunning(task.id); first.close();
  const second = new LocalTaskStore(filename);
  t.after(async () => { second.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(second.get(task.id).status, "interrupted");
});

test("isolated delivery rejects a non-Git directory without mutating it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-not-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runIsolatedLocalCoder({ id: "00000000-0000-4000-8000-000000000001", repository: directory, objective: "test", model: "local" }, { dataDirectory: join(directory, "data") });
  assert.equal(result.ok, false);
  assert.match(result.message, /not a Git work tree/u);
});

test("Git worktree command accepts an ordinary repository path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", directory], { encoding: "utf8" }).status, 0);
  const check = spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  assert.equal(check.stdout.trim(), "true");
});
