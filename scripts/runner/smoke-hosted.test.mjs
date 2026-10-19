import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
