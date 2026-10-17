import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('packaged native runtime is the exact pinned Capacitor module with its license',async()=>{
 const normalize=s=>s.replace(/\r\n/g,'\n');
 assert.equal(normalize(await readFile(new URL('../www/vendor/capacitor.js',import.meta.url),'utf8')),normalize(await readFile(new URL('../node_modules/@capacitor/core/dist/index.js',import.meta.url),'utf8')));
 assert.equal(normalize(await readFile(new URL('../www/vendor/LICENSE',import.meta.url),'utf8')),normalize(await readFile(new URL('../node_modules/@capacitor/core/LICENSE',import.meta.url),'utf8')));
});
