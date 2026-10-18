import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
test('packaged native runtime and license match recorded pinned package provenance',async()=>{
 const read=path=>readFile(new URL(path,import.meta.url),'utf8');
 const manifest=JSON.parse(await read('../www/vendor/manifest.json'));
 const pkg=JSON.parse(await read('../package.json'));
 const hash=s=>createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex');
 assert.equal(pkg.dependencies[manifest.package],manifest.version);
 assert.equal(hash(await read('../www/vendor/capacitor.js')),manifest.moduleSha256);
 assert.equal(hash(await read('../www/vendor/LICENSE')),manifest.licenseSha256);
});
