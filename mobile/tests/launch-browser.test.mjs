import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../www/',import.meta.url));
test('packaged phone UI pairs through native adapters, keeps secrets out of browser storage and hides failures',async t=>{
  if(!process.env.ATLAS_TEST_PLAYWRIGHT) { t.skip('Set ATLAS_TEST_PLAYWRIGHT and ATLAS_TEST_BROWSER for actual packaged UI acceptance.');return; }
  const {chromium}=await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href);
  const server=createServer(async(req,res)=>{
    try {const name=req.url==='/'?'index.html':req.url.slice(1);const path=resolve(root,name);if(!path.startsWith(root))throw new Error();res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(path)]||'text/plain');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.ATLAS_TEST_BROWSER});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(()=>{
    window.androidBridge={};window.vault=new Map();window.fail=false;window.vaultFail=true;window.httpCalls=0;
    window.Capacitor={PluginHeaders:[{name:'SecureStoragePlugin',methods:['get','set','remove'].map(name=>({name,rtype:'promise'}))},{name:'CapacitorHttp',methods:[{name:'request',rtype:'promise'}]}],nativePromise:async(plugin,method,options)=>{
      if(plugin==='SecureStoragePlugin') {if(window.vaultFail)throw new Error('PRIVATE_KEYCHAIN_FAILURE');if(method==='get')return {value:window.vault.get(options.key)};if(method==='set')window.vault.set(options.key,options.value);if(method==='remove')window.vault.delete(options.key);return {};}
      window.httpCalls++;
      if(window.fail)throw new Error('PRIVATE_BACKEND_STACK');
      return {status:200,url:options.url,data:options.method==='POST'?{device:{id:'phone'},deviceToken:'a'.repeat(43)}:options.url.endsWith('/tasks')?{tasks:[{error:'PRIVATE_TASK_STACK'}]}:{approvals:[{status:'pending',summary:'PRIVATE_APPROVAL'}]}};
    }};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'Retry secure setup'}).waitFor();
  assert.equal(await page.locator('form').isVisible(),false);assert.equal(await page.evaluate(()=>window.httpCalls),0);assert.equal((await page.locator('body').innerText()).includes('PRIVATE'),false);
  await page.evaluate(()=>{window.vaultFail=false});await page.getByRole('button',{name:'Retry secure setup'}).click();
  await page.locator('form').waitFor();assert.equal(await page.evaluate(()=>window.vault.size),0);
  await page.locator('#origin').fill('https://atlas.example');await page.locator('#code').fill('123456');await page.getByRole('button',{name:'Pair securely'}).click();
  await page.waitForFunction(()=>document.querySelector('#tasks').textContent==='1');
  assert.equal(await page.locator('#approvals').textContent(),'1');
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  assert.equal(await page.locator('body').innerText().then(text=>text.includes('PRIVATE')),false);
  await page.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('details').getAttribute('open'),'');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>{window.fail=true});await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('could not connect'));
  assert.equal((await page.locator('body').innerText()).includes('PRIVATE'),false);
  await page.getByRole('button',{name:'Disconnect device',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('form').hidden);
  assert.equal(await page.evaluate(()=>window.vault.size),0);
});

