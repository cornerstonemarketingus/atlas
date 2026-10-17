import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceClient, trustedOrigin } from '../www/device-client.mjs';
const token = 'a'.repeat(43);
function fixture(request) {
  const values = new Map();
  const vault = { async get({key}) { return {value:values.get(key)}; }, async set({key,value}) { values.set(key,value); }, async remove({key}) { values.delete(key); } };
  const calls = [];
  const http = { async request(options) { calls.push(options); return request ? request(options) : {status:201,url:options.url,data:{device:{id:'phone'},deviceToken:token}}; } };
  return { client:createDeviceClient({http,vault,timeoutMs:20}),values,calls,vault };
}
test('pair uses existing endpoint, binds a token to HTTPS origin in vault, and reads safe counts', async () => {
  const f = fixture(options => ({status:200,url:options.url,data:options.method==='POST'?{device:{id:'phone'},deviceToken:token}:options.url.endsWith('/tasks')?{tasks:[{error:'PRIVATE'}]}:{approvals:[{status:'pending',summary:'PRIVATE'}]}}));
  assert.equal(await f.client.pair({origin:'https://atlas.example',code:'123456'}),true);
  assert.equal(f.calls[0].disableRedirects,true);
  assert.equal(f.calls[0].headers.Authorization,undefined);
  assert.deepEqual(await f.client.refresh(),{tasks:1,approvals:1});
  assert.equal(f.calls[1].headers.Authorization,`Bearer ${token}`);
  assert.equal(JSON.parse([...f.values.values()][0]).origin,'https://atlas.example');
  await f.client.disconnect(); assert.equal(f.values.size,0);
});
test('invalid endpoints and codes never send requests',async()=>{
  const f=fixture();
  for(const origin of ['http://atlas.example','https://user:pass@atlas.example','https://atlas.example/path','https://atlas.example/?x=1','https://atlas.example/#x']) assert.throws(()=>trustedOrigin(origin));
  await assert.rejects(f.client.pair({origin:'https://atlas.example',code:'abc'}));
  assert.equal(f.calls.length,0);
});
test('redirects, raw failures and malformed credentials never persist',async()=>{
  for(const response of [{status:302,url:'https://atlas.example/v1/pair/claim',data:{}},{status:200,url:'https://evil.example/v1/pair/claim',data:{deviceToken:token,device:{id:'x'}}},{status:500,url:'https://atlas.example/v1/pair/claim',data:{message:'PRIVATE_DATABASE_PATH'}},{status:201,url:'https://atlas.example/v1/pair/claim',data:{deviceToken:'invalid'}}]) {
    const f=fixture(()=>response);
    await assert.rejects(f.client.pair({origin:'https://atlas.example',code:'123456'}),error=>!error.message.includes('PRIVATE'));
    assert.equal(f.values.size,0);
  }
});
test('a timed out pairing is not retried or saved when its response arrives late',async()=>{
  let finish;
  const f=fixture(()=>new Promise(resolve=>{finish=resolve}));
  await assert.rejects(f.client.pair({origin:'https://atlas.example',code:'123456'}));
  finish({status:201,url:'https://atlas.example/v1/pair/claim',data:{deviceToken:token,device:{id:'x'}}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.calls.length,1);assert.equal(f.values.size,0);
});
test('disconnect fences an in-flight pairing response',async()=>{
  let finish;
  const f=fixture(()=>new Promise(resolve=>{finish=resolve}));
  const pending=f.client.pair({origin:'https://atlas.example',code:'123456'});
  await f.client.disconnect();
  finish({status:201,url:'https://atlas.example/v1/pair/claim',data:{deviceToken:token,device:{id:'x'}}});
  assert.equal(await pending,false);assert.equal(f.values.size,0);
});

test('native vault write failures cannot become customer diagnostic text',async()=>{
 const f=fixture();f.vault.set=async()=>{throw new Error('PRIVATE_KEYCHAIN_STACK');};
 await assert.rejects(f.client.pair({origin:'https://atlas.example',code:'123456'}),error=>!error.message.includes('PRIVATE')&&error.message.includes('secure device access'));
 await assert.rejects(f.client.refresh(),/Pair this device/);
});
