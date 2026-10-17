import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath,pathToFileURL } from 'node:url';
let playwright;
try{playwright=await import(process.env.ATLAS_TEST_PLAYWRIGHT?pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href:'playwright-core')}catch{ /* Browser acceptance is optional without configured Playwright. */ }
test('actual account component hides backend failures and recovers uncertain deletion responses without duplicate submits',{skip:!playwright&&'Configure Playwright for browser acceptance',timeout:60000},async t=>{
 const {createServer}=await import('vite');const {default:react}=await import('@vitejs/plugin-react');
 const html='<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{AccountPrivacy}from"/app/account/AccountPrivacy.tsx";createRoot(document.getElementById("root")).render(React.createElement(AccountPrivacy));</script></body></html>';
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),configFile:false,cacheDir:'../../.account-privacy-cache',plugins:[{name:'account-boundary-fixture',enforce:'pre',resolveId(id,importer){if(id==='next/link')return '\0account-link';if(id==='../AtlasShell.js'&&importer?.includes('AccountPrivacy'))return '\0account-shell'},load(id){if(id==='\0account-link')return 'import React from "react";export default function Link(props){return React.createElement("a",props)}';if(id==='\0account-shell')return 'import React from "react";export function AtlasShell({children}){return React.createElement("main",null,children)}'},configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();void vite.transformIndexHtml('/',html).then(body=>{res.setHeader('Content-Type','text/html');res.end(body)})})}},react()],resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0}});
 await server.listen();t.after(()=>server.close());
 const browser=await playwright.chromium.launch({headless:true,...(process.env.ATLAS_TEST_BROWSER?{executablePath:process.env.ATLAS_TEST_BROWSER}:{})});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let mode='failure',posts=0;
 await page.route('**/api/account',route=>route.fulfill({json:{signedIn:true,tier:'free'}}));
 await page.route('**/api/billing/checkout',route=>route.fulfill({status:502,json:{message:'PRIVATE_STRIPE_SECRET /srv/atlas/internal'}}));
 await page.route('**/api/account/deletion',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{request:null}});
  posts++;await new Promise(resolve=>setTimeout(resolve,100));
  if(mode==='failure')return route.fulfill({status:503,json:{message:'PRIVATE_DATABASE_SECRET /srv/atlas/internal'}});
  if(mode==='invalid')return route.fulfill({status:200,contentType:'text/html',body:'PRIVATE_GATEWAY_FAILURE'});
  return route.fulfill({status:201,json:{request:{status:'pending',requestedAt:'2026-10-17T12:00:00.000Z'}}});
 });
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
 await page.getByRole('button',{name:'Upgrade to Pro'}).click();await page.getByText('Billing is temporarily unavailable. Try again shortly.').waitFor();
 await page.getByLabel('Type DELETE to confirm').fill('DELETE');
 await page.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()});
 await page.getByText('We could not confirm your deletion request. Refresh the page before trying again.').waitFor();assert.equal(posts,1);assert.equal(await page.getByRole('button',{name:'Request account deletion'}).isEnabled(),true);
 mode='invalid';await page.getByRole('button',{name:'Request account deletion'}).click();await page.waitForFunction(()=>!document.querySelector('.danger-form button').disabled);assert.equal(posts,2);
 assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE_|\/srv\/atlas/);
 mode='success';await page.getByRole('button',{name:'Request account deletion'}).click();await page.getByText('Deletion requested. We will remove eligible account data within 30 days.').waitFor();assert.equal(posts,3);assert.deepEqual(errors,[]);
});
