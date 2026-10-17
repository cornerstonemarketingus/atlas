import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { encodeEvent } from "../app/api/chat/stream.mjs";
let playwright;
try { playwright = await import(process.env.ATLAS_TEST_PLAYWRIGHT ? pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href : "playwright-core"); } catch { /* Browser gate is optional without configured Playwright. */ }
test("customer activity folds with accessible plus/minus controls on desktop and mobile", { skip: !playwright && "Configure Playwright for browser acceptance", timeout:60000 }, async t => {
 const {createServer}=await import("vite"); const {default:react}=await import("@vitejs/plugin-react");
 const wire=encodeEvent("thinking",{text:"PRIVATE_BUILD_SENTINEL"})+encodeEvent("tool",{id:"call_1",state:"done",label:"PRIVATE_BUILD_SENTINEL",preview:{content:"PRIVATE_BUILD_SENTINEL"}});
 const html='<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {ToolSteps} from "/app/chat/Workspace.tsx";import {createEventParser} from "/app/api/chat/stream.mjs"; const steps=createEventParser().push('+JSON.stringify(wire)+').filter(e=>e.type==="tool").map(e=>e.data);createRoot(document.getElementById("root")).render(React.createElement(ToolSteps,{steps}));</script></body></html>';
 const server=await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,cacheDir:"../../.customer-activity-cache",plugins:[react(),{name:"activity-fixture",configureServer(vite){vite.middlewares.use((request,response,next)=>{if(request.url!=="/")return next();void vite.transformIndexHtml("/",html).then(body=>{response.setHeader("Content-Type","text/html");response.end(body);});});}}],resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0}});
 await server.listen();t.after(()=>server.close());
 const browser=await playwright.chromium.launch({headless:true,...(process.env.ATLAS_TEST_BROWSER?{executablePath:process.env.ATLAS_TEST_BROWSER}:{})});t.after(()=>browser.close());
 const address=server.httpServer.address();
 for(const viewport of [{width:1280,height:800},{width:390,height:844}]){
 const page=await browser.newPage({viewport});const errors=[];page.on("pageerror",error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+address.port);
 const summary=page.locator("details > summary");await summary.waitFor();assert.equal(await page.locator("details").getAttribute("open"),null);
 assert.match(await summary.evaluate(element=>getComputedStyle(element,"::before").content),/\+/);
 await summary.focus();await page.keyboard.press("Enter");assert.notEqual(await page.locator("details").getAttribute("open"),null);
 assert.match(await summary.evaluate(element=>getComputedStyle(element,"::before").content),/−/);
 assert.match(await page.locator("body").innerText(),/Step completed/);assert.doesNotMatch(await page.content(),/PRIVATE_BUILD_SENTINEL/);
 await page.keyboard.press("Enter");assert.equal(await page.locator("details").getAttribute("open"),null);assert.deepEqual(errors,[]);await page.close();
 }
});
