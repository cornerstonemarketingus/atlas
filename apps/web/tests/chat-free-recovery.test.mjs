import assert from 'node:assert/strict';
import test from 'node:test';
import { callModel, converse, rateLimitDetails, retryAfterMs } from '../app/api/chat/agent-loop.mjs';
const endpoint = { baseUrl: 'https://free.example/v1/', model: 'large', fallbackModel: 'small', providerFallback: { baseUrl: 'https://api.openai.com/v1/', model: 'paid', provider: 'openai' } };
const rate = (body = '', headers = {}) => new Response(body, { status: 429, headers });
const answer = () => Response.json({ choices: [{ message: { content: 'Finished from repository evidence.' } }] });

test('free fallback gets one short retry before any paid escalation', async () => {
  const models = [], waits = [];
  const response = await callModel(endpoint, [{ role: 'user', content: 'hello' }], { sleep: async ms => waits.push(ms), fetcher: async (_url, init) => {
    const model = JSON.parse(init.body).model; models.push(model);
    return models.length === 3 ? answer() : rate('', { 'retry-after': model === 'large' ? '60' : '1' });
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(models, ['large', 'small', 'small']);
  assert.deepEqual(waits, [1000]);
});

test('billing errors do not retry; free reset survives an unfunded paid fallback', async () => {
  const models = [], waits = [], billingBlocked = new Set();
  const options = { billingBlocked, sleep: async ms => waits.push(ms), fetcher: async (_url, init) => {
    const model = JSON.parse(init.body).model; models.push(model);
    return model === 'paid' ? rate(JSON.stringify({ error: { code: 'insufficient_quota', message: 'PRIVATE_SENTINEL' } })) : rate('Please try again in 2m59.56s.');
  } };
  for (let i = 0; i < 2; i++) {
    const response = await callModel(endpoint, [], options);
    assert.equal(retryAfterMs(response.headers, await response.text()), 179560);
  }
  assert.equal(models.filter(m => m === 'paid').length, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(rateLimitDetails('{"error":{"code":"insufficient_quota","message":"PRIVATE_SENTINEL"}}'), { category: 'billing' });
});

test('an oversized tool result is retried as a marked excerpt, without losing tool identity or mutating saved evidence', async () => {
  const turns = [{ role: 'system', content: 'Trusted rules' }, { role: 'user', content: 'Read the code' }, { role: 'assistant', tool_calls: [{ id: 'read1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'read1', content: '<data>\n' + 'code '.repeat(4000) + '</data>' }];
  const original = JSON.stringify(turns), calls = [];
  const response = await callModel({ ...endpoint, fallbackModel: null, providerFallback: null }, turns, { fetcher: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1 ? rate('{"error":{"message":"Request too large on tokens per minute (TPM): Limit 6000, Requested 12000"}}') : answer();
  } });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(turns), original);
  assert.deepEqual(calls[1].messages.slice(0, 3), turns.slice(0, 3));
  assert.equal(calls[1].messages[3].tool_call_id, 'read1');
  assert.match(calls[1].messages[3].content, /excerpt shortened.*<\/data>/su);
  assert.ok(calls[1].messages[3].content.length < turns[3].content.length / 2);
});

test('oversized context honors explicit long retry-after and never immediately resends', async () => {
  let calls = 0;
  const response = await callModel({ ...endpoint, fallbackModel: null, providerFallback: null }, [{ role: 'tool', content: 'x'.repeat(5000) }], { fetcher: async () => { calls++; return rate('Request too large on tokens per minute (TPM)', { 'retry-after': '120' }); } });
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

for (const code of ['credit_balance_exhausted', 'billing_hard_limit_reached']) test(`conversation reports ${code} without prompt leakage or pointless waits`, async t => {
  const logs = []; t.mock.method(console, 'warn', line => logs.push(line));
  let calls = 0;
  const result = await converse({ endpoint: endpoint.providerFallback, turns: [{ role: 'user', content: 'hello' }], stream: false, emit: () => {}, sleep: async () => assert.fail('billing must not wait'), fetcher: async () => { calls++; return rate(JSON.stringify({ error: { code, message: 'PRIVATE_SENTINEL' } })); } });
  assert.equal(calls, 1);
  assert.match(result.error, /API credits/);
  assert.doesNotMatch(JSON.stringify({ result, logs }), /PRIVATE_SENTINEL/);
});

test('HTTP date retry-after is recognized instead of defaulting to two seconds', () => {
  const wait = retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() + 120000).toUTCString() }));
  assert.ok(wait > 118000 && wait <= 120000);
});

for (const stream of [false, true]) test(`real tool loop completes after oversized repository evidence (stream=${stream})`, async () => {
  let calls = 0;
  const result = await converse({ endpoint: { ...endpoint, fallbackModel: null, providerFallback: null }, turns: [{ role: 'user', content: 'Read and inspect' }], stream, emit: () => {}, allowTasks: false,
    tools: [{ type: 'function', function: { name: 'read_code', parameters: { type: 'object', properties: {} } } }],
    handlers: { read_code: async () => ({ ok: true, label: 'Read repository code', content: '<data>\n' + 'source '.repeat(4000) + '</data>' }) },
    fetcher: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      if (calls === 1) return Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_code', arguments: '{}' } }] } }] });
      if (body.messages.some(m => m.role === 'tool' && m.content.length > 10000)) return rate('Request too large on tokens per minute (TPM): Limit 6000, Requested 14000');
      return stream ? new Response('data: {"choices":[{"delta":{"content":"Finished from repository evidence."}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : answer();
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.reply, 'Finished from repository evidence.');
  assert.equal(result.finalization, undefined);
  assert.equal(result.steps[0].ok, true);
});

test('both free models stop after one short retry each and never loop', async () => {
  const models = [], waits = [];
  const response = await callModel({ ...endpoint, providerFallback: null }, [], { sleep: async ms => waits.push(ms), fetcher: async (_url, init) => { models.push(JSON.parse(init.body).model); assert.ok(models.length <= 4); return rate('', { 'retry-after': '1' }); } });
  assert.equal(response.status, 429);
  assert.deepEqual(models, ['large', 'large', 'small', 'small']);
  assert.deepEqual(waits, [1000, 1000]);
});

for (const oversized of [false, true]) test(`billing encountered on a retry is excluded on the next call (oversized=${oversized})`, async () => {
  let calls = 0;
  const options = { billingBlocked: new Set(), sleep: async () => {}, fetcher: async () => {
    calls++;
    if (calls === 1) return oversized ? rate('Request too large on tokens per minute (TPM)') : rate('', { 'retry-after': '1' });
    return rate('{"error":{"code":"insufficient_quota"}}');
  } };
  const turns = [{ role: 'tool', content: 'evidence '.repeat(1000) }];
  for (let i = 0; i < 2; i++) assert.equal((await callModel(endpoint.providerFallback, turns, options)).status, 429);
  assert.equal(calls, 2);
});
