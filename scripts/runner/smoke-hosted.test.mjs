import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('real coder smoke requests a fresh change on every invocation', async () => {
  const objectives = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers['oai-authenticated-user-id']) { res.statusCode = 401; res.end('{}'); return; }
    let data = ''; for await (const chunk of req) data += chunk;
    const route = req.url;
    if (route === '/api/setup/status') res.end(JSON.stringify({ overall: 'ready', completedSteps: 1, totalSteps: 1 }));
    else if (route === '/api/settings/repositories') res.end(JSON.stringify({ repositories: [] }));
    else if (route === '/api/tasks' && req.method === 'POST') {
      objectives.push(JSON.parse(data).objective);
      res.end(JSON.stringify({ recorded: true, taskId: 'task', conversationId: 'conversation' }));
    } else if (route === '/api/tasks') res.end(JSON.stringify({ tasks: [{ taskId: 'task', status: 'succeeded', pullRequest: { url: 'https://example.com/pr' } }] }));
    else res.end(JSON.stringify({ events: [{ taskId: 'task', kind: 'result', detail: '**verified**' }], messages: [{ role: 'assistant', content: '**verified**' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./smoke-hosted.mjs', import.meta.url))], {
        cwd: process.env.TEMP || process.env.TMPDIR || '/tmp',
        env: { ...process.env, ATLAS_SMOKE_MODE: 'coder', ATLAS_OPERATOR_TOKEN: 'test-only', ATLAS_SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: 'pipe',
      });
      let output = ''; child.stderr.on('data', chunk => output += chunk); child.stdout.resume();
      assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, output);
    }
    assert.notEqual(objectives[0], objectives[1], 'a completed previous smoke must not satisfy the next objective');
    for (const objective of objectives) assert.match(objective, /docs\/ATLAS-SMOKE-CHECK-[a-f0-9-]+\.md/u);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('chat release gate requires model authorship in both response modes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-chat-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let variant = 'unconfirmed';
  const server = http.createServer(async (req, res) => {
    if (req.headers['oai-authenticated-user-id']) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/api/setup/status') { res.end(JSON.stringify({ overall: 'ready', completedSteps: 8, totalSteps: 8 })); return; }
    let data = ''; for await (const chunk of req) data += chunk;
    const input = JSON.parse(data);
    const outcome = { stored: true, conversationId: 'test', reply: { content: 'A saved reply can exist even when no model answered.' },
      ...(variant === 'confirmed' || (variant === 'stream-unconfirmed' && !input.stream) ? { servedBy: { provider: 'test-provider', model: 'test-model' } } : {}) };
    if (input.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end('event: done\ndata: ' + JSON.stringify(outcome) + '\n\n');
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(outcome)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const scenario of ['unconfirmed', 'stream-unconfirmed', 'confirmed']) {
    variant = scenario;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./smoke-hosted.mjs', import.meta.url))], {
      cwd: directory, env: { ...process.env, ATLAS_SMOKE_MODE: 'chat', ATLAS_OPERATOR_TOKEN: 'test-only', ATLAS_SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise(resolve => child.on('close', resolve));
    if (scenario !== 'confirmed') {
      assert.notEqual(code, 0, output);
      assert.match(output, /model authorship not confirmed/);
      assert.match(output, /Chat release gate failed/);
    } else {
      assert.equal(code, 0, output);
      assert.match(output, /Chat release gate passed/);
    }
  }
});

test('website verification creates a preview, reads public pages and confirms persistence without model calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-website-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'gen_12345678-1234-1234-1234-123456789abc';
  const previewUrl = `/preview/${id}`;
  let created = false, pageRead = false, statusRead = false, headersPresent = true;
  const project = { hosted: true, projectId: id, previewUrl, status: 'ready', deploymentState: 'not-deployed', pages: [{ path: previewUrl }],
    verification: { structure: 'passed', browserChecks: 'not-run', enquiryDelivery: 'preview-only' } };
  const server = http.createServer(async (req, res) => {
    if (req.headers['oai-authenticated-user-id']) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/api/setup/status') { res.end(JSON.stringify({ overall: 'ready', completedSteps: 8, totalSteps: 8, optional: { chat: { route: ['workers-ai'] } } })); return; }
    if (req.url === '/api/genesis/operations' && req.method === 'GET') { res.end(JSON.stringify({ github: { reason: 'execution_node_not_configured' } })); return; }
    if (req.url === '/api/genesis/operations' && req.method === 'POST') {
      let data = ''; for await (const chunk of req) data += chunk;
      assert.equal(JSON.parse(data).template, 'static-site');
      created = true; res.end(JSON.stringify(project)); return;
    }
    if (req.url === previewUrl) {
      assert.equal(req.headers.authorization, undefined, 'the preview is opened without credentials');
      pageRead = true;
      if (headersPresent) { res.setHeader('content-security-policy', "default-src 'none'; form-action 'none'"); res.setHeader('x-robots-tag', 'noindex'); }
      res.end('Atlas Verification. This site is not published.'); return;
    }
    if (req.url === `/api/genesis/operations?id=${id}`) { statusRead = true; res.end(JSON.stringify(project)); return; }
    res.writeHead(500); res.end('Unexpected request');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const safe of [true, false]) {
    headersPresent = safe;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./smoke-hosted.mjs', import.meta.url))], {
      cwd: directory, env: { ...process.env, ATLAS_SMOKE_MODE: 'website', ATLAS_OPERATOR_TOKEN: 'test-only', ATLAS_SMOKE_BASE_URL: `http://127.0.0.1:${server.address().port}` }, stdio: 'pipe',
    });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const code = await new Promise(resolve => child.on('close', resolve));
    if (safe) { assert.equal(code, 0, output); assert.ok(created && pageRead && statusRead); assert.match(output, /Hosted website gate passed/); }
    else { assert.notEqual(code, 0, output); assert.match(output, /safety headers were missing/); }
  }
});
