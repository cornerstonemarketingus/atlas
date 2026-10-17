import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceClient } from '../www/device-client.mjs';
import { LocalTaskStore } from '../../apps/local-control/src/store.mjs';
import { createLocalControlServer } from '../../apps/local-control/src/server.mjs';

test('paired launch consumes the real daemon code, restores a device session and rejects revoked access',async t=>{
  const store=new LocalTaskStore(':memory:');
  const owner='owner-test-token-'.repeat(4);
  const server=createLocalControlServer({store,token:owner,runTask:async()=>({ok:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const response=await fetch(local+'/v1/pair',{method:'POST',headers:{Authorization:`Bearer ${owner}`}});
  assert.equal(response.status,201);
  const {code}=await response.json();
  const values=new Map();
  const vault={async get({key}){return {value:values.get(key)}},async set({key,value}){values.set(key,value)},async remove({key}){values.delete(key)}};
  const calls=[];
  // Only this test adapter maps the configured HTTPS origin to a loopback HTTP fixture.
  // Production transport is CapacitorHttp; this proves real daemon contracts, not native TLS.
  const http={async request(options){
    calls.push(options);assert.equal(new URL(options.url).origin,'https://atlas.example');assert.equal(options.disableRedirects,true);
    const result=await fetch(local+new URL(options.url).pathname,{method:options.method,headers:options.headers,body:options.data?JSON.stringify(options.data):undefined,redirect:'manual'});
    return {status:result.status,url:options.url,data:await result.json()};
  }};
  const client=createDeviceClient({http,vault});
  assert.equal(await client.pair({origin:'https://atlas.example',code}),true);
  assert.deepEqual(await client.refresh(),{tasks:0,approvals:0});
  assert.equal(calls.filter(call=>call.method==='POST').length,1);
  const restored=createDeviceClient({http,vault});
  assert.equal(await restored.restore(),true);
  assert.deepEqual(await restored.refresh(),{tasks:0,approvals:0});
  const replay=createDeviceClient({http,vault:{...vault,async set(){throw new Error('should not persist')}}});
  await assert.rejects(replay.pair({origin:'https://atlas.example',code}),/could not connect/);
  const device=store.devices()[0];assert.ok(device.id);store.revokeDevice(device.id);
  await assert.rejects(restored.refresh(),error=>error.message==='Atlas could not connect. Check your connection and try again.');
  await client.disconnect();assert.equal(values.size,0);
  assert.equal(calls.some(call=>call.url.includes('/decision')),false);
});
