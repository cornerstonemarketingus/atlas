import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const secret='PRIVATE_BACKEND /srv/atlas/private.ts token=do-not-display';
const moduleUrl=code=>'data:text/javascript,'+encodeURIComponent(code);
async function route(path){
 let source=await readFile(new URL(path,import.meta.url),'utf8');
 const modules={
  'drizzle-orm':`export const eq=(...args)=>args;export const desc=x=>x;export const and=(...args)=>args;`,
  '../../../../db':`export const getDb=()=>globalThis.__accountFixture.db;`,
  '../../../../db/schema':`export const subscriptions={userId:'userId'};export const accountDeletionRequests={requestedBy:'requestedBy',requestedAt:'requestedAt',status:'status'};`,
  '../../tasks/operator-auth.mjs':`export const authenticatedAccount=async()=>{const f=globalThis.__accountFixture;if(f.authError)throw new Error(f.authError);return f.account};`,
  '../stripe.mjs':`export const stripeConfiguration=()=>({configured:true});export const createCheckoutSession=async()=>{const f=globalThis.__accountFixture;if(f.providerError)throw new Error(f.providerError);return 'https://checkout.stripe.com/test'};export const createPortalSession=createCheckoutSession;`,
  '../../customer-failure.mjs':null,
 };
 for(const [name,code]of Object.entries(modules))source=source.replaceAll(`from "${name}"`,`from ${JSON.stringify(code===null?new URL('../app/api/customer-failure.mjs',import.meta.url).href:moduleUrl(code))}`).replaceAll(`from '${name}'`,`from ${JSON.stringify(code===null?new URL('../app/api/customer-failure.mjs',import.meta.url).href:moduleUrl(code))}`);
 return import(moduleUrl(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText));
}
const checkout=await route('../app/api/billing/checkout/route.ts');
const portal=await route('../app/api/billing/portal/route.ts');
const deletion=await route('../app/api/account/deletion/route.ts');
function fixture(rows=[]){
 const f={account:{userId:'customer-1',dbUserId:1},rows,conditions:[],writes:[]};
 const query={from(){return this},where(condition){f.conditions.push(condition);return this},orderBy(){return this},limit(){return Promise.resolve(f.rows)},then(resolve,reject){return Promise.resolve(f.rows).then(resolve,reject)}};
 f.db={select(){if(f.databaseError)throw new Error(secret);return query},insert(){return{values:async row=>{if(f.databaseError)throw new Error(secret);f.writes.push(row)}}}};
 globalThis.__accountFixture=f;return f;
}
const request=body=>new Request('https://atlas.example/api/account/deletion',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function safe(response,status){assert.equal(response.status,status);const text=await response.text();assert.equal(text.includes('PRIVATE'),false);const body=JSON.parse(text);assert.match(body.reference,/^[0-9a-f-]{36}$/);assert.equal(response.headers.get('cache-control'),'no-store');return body;}
test('actual billing handlers never return provider, database or authentication exception text',async()=>{
 for(const endpoint of [checkout,portal]){
  for(const failure of ['providerError','databaseError','authError']){
   const f=fixture([{stripeCustomerId:'cus_fixture'}]);f[failure]=secret;
   await safe(await endpoint.POST(request({tier:'pro'})),failure==='authError'?503:502);
  }
  fixture();globalThis.__accountFixture.account=null;assert.equal((await endpoint.POST(request({tier:'pro'}))).status,401);
  fixture([{stripeCustomerId:'cus_fixture'}]);assert.match((await (await endpoint.POST(request({tier:'pro'}))).json()).url,/https:\/\//);
 }
});
test('deletion rejects malformed JSON shapes without mutation and preserves confirmation/auth gates',async()=>{
 for(const body of [null,[],{},'DELETE',{confirmation:'wrong'}]){const f=fixture();assert.equal((await deletion.POST(request(body))).status,400);assert.equal(f.writes.length,0);}
 fixture();globalThis.__accountFixture.account=null;assert.equal((await deletion.POST(request({confirmation:'DELETE'}))).status,401);
 fixture();globalThis.__accountFixture.account.dbUserId=null;assert.equal((await deletion.POST(request({confirmation:'DELETE'}))).status,400);
});
test('deletion responses project only customer lifecycle fields, keep account scoping and hide failures',async()=>{
 const row={status:'pending',requestedAt:'2026-10-17T12:00:00.000Z',note:secret,requestedBy:'customer-1',userId:1};
 const f=fixture([row]);const response=await deletion.GET(new Request('https://atlas.example/api/account/deletion'));
 assert.deepEqual(await response.json(),{request:{status:row.status,requestedAt:row.requestedAt}});assert.deepEqual(f.conditions[0],['requestedBy','customer-1']);
 assert.deepEqual(await (await deletion.POST(request({confirmation:'DELETE'}))).json(),{request:{status:row.status,requestedAt:row.requestedAt}});assert.equal(f.writes.length,0);
 for(const method of ['GET','POST']){const broken=fixture();broken.databaseError=true;await safe(await deletion[method](request({confirmation:'DELETE'})),503);}
 const fresh=fixture();assert.equal((await deletion.POST(request({confirmation:'DELETE'}))).status,201);assert.equal(fresh.writes[0].requestedBy,'customer-1');
});
