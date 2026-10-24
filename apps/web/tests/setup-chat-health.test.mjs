import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCardSummary, chatRouteSummary, providerChecks, providerName, quotaSummary, toneClass, utcTime, TONE } from '../app/setup/chat-health.mjs';
import { CREDENTIAL_CATEGORIES } from '../app/api/chat/provider-health.mjs';

test('the chat route reads as plain language, in order', () => {
  assert.equal(providerName('workers-ai'), 'Cloudflare Workers AI');
  assert.equal(providerName('something-new'), 'another provider');
  const none = chatRouteSummary({ configured: false, route: [] });
  assert.equal(none.tone, TONE.BAD); assert.match(none.headline, /No chat provider/u);
  const one = chatRouteSummary({ configured: true, route: ['groq'], modelPoolSize: 1, webSearchConfigured: false });
  assert.equal(one.tone, TONE.WARN); assert.match(one.detail, /^Chat uses Groq and has no other provider/u); assert.match(one.detail, /Web search is off\.$/u);
  const many = chatRouteSummary({ configured: true, route: ['groq', 'workers-ai', 'openai'], modelPoolSize: 3, fallbackModelConfigured: true, webSearchConfigured: true });
  assert.equal(many.tone, TONE.GOOD);
  assert.match(many.detail, /Chat tries Groq, Cloudflare Workers AI, then OpenAI\. 3 models share the main provider; a fallback model is set; web search is on\./u);
  assert.equal(chatRouteSummary(undefined).tone, TONE.UNKNOWN, 'an older deployment without the field is not treated as broken');
});

test('quota health covers off, unreachable, limited, paused and healthy', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  assert.match(quotaSummary({ bound: false }).headline, /off/u);
  assert.match(quotaSummary({ bound: true, reachable: null }).headline, /Waiting/u);
  assert.match(quotaSummary({ bound: true, reachable: false }).headline, /did not answer/u);
  const paused = quotaSummary({ bound: true, reachable: true, models: 2, reservations: 0, waiting: 0, limitedModels: 0, accountPause: { kind: 'AUTHENTICATION', until: '2026-10-21T10:15:00.000Z' } }, now);
  assert.equal(paused.tone, TONE.BAD); assert.match(paused.detail, /refused the model key\. It tries again after 10:15 UTC\./u);
  const limited = quotaSummary({ bound: true, reachable: true, models: 3, reservations: 1, waiting: 2, limitedModels: 1, accountPause: null }, now);
  assert.equal(limited.tone, TONE.WARN); assert.equal(limited.headline, '1 model is at a limit'); assert.match(limited.detail, /1 request in flight, 2 waiting\./u);
  const healthy = quotaSummary({ bound: true, reachable: true, models: 0, reservations: 0, waiting: 0, limitedModels: 0, accountPause: null }, now);
  assert.equal(healthy.tone, TONE.GOOD); assert.equal(healthy.headline, 'Within provider limits');
  assert.equal(utcTime('2026-10-22T03:04:00Z', now), 'Oct 22, 03:04 UTC');
  assert.equal(utcTime('not a date', now), null);
});

test('every provider category the server can report has its own plain-language row', () => {
  for (const category of [...CREDENTIAL_CATEGORIES, 'BINDING_MISSING']) {
    const [row] = providerChecks({ providers: { workersAIBinding: { category } } });
    assert.notEqual(row.headline, 'Not reported', category);
  }
  const rows = providerChecks({ providers: { workersAI: { category: 'CREDENTIAL_INVALID' }, workersAIBinding: { category: 'OK' } } });
  assert.deepEqual(rows.map(row => [row.id, row.tone]), [['workersAIBinding', 'good'], ['workersAI', 'bad']]);
  assert.equal(toneClass(TONE.GOOD), 'status-card good');
  assert.equal(toneClass(TONE.UNKNOWN), 'status-card');
});

test('the chat card says configured, never connected, without evidence of a real reply', () => {
  const model = { configured: true, reason: null };
  const quiet = { bound: true, reachable: true, models: 1, reservations: 0, waiting: 0, limitedModels: 0, accountPause: null, failingModels: 0, recentFailureKinds: [] };
  for (const card of [chatCardSummary({ model, owner: true, governor: quiet }), chatCardSummary({ model, owner: true }), chatCardSummary({ model, owner: false })]) {
    assert.doesNotMatch(`${card.headline} ${card.detail}`, /connected|working/iu);
    assert.notEqual(card.tone, TONE.GOOD);
  }
  // The usability-test case: configured, but the binding answered 502.
  const failed = chatCardSummary({ model, owner: true, governor: { ...quiet, failingModels: 1, recentFailureKinds: ['SERVER_ERROR'] } });
  assert.equal(failed.tone, TONE.BAD); assert.equal(failed.headline, 'Configured, but recent calls failed');
  assert.match(failed.detail, /failed with server errors \(5xx\)\./u);
  const limited = chatCardSummary({ model, owner: true, governor: { ...quiet, limitedModels: 2 } });
  assert.match(limited.detail, /2 models failed with rate limits \(429\)/u);
  assert.match(chatCardSummary({ model, owner: true, governor: { ...quiet, accountPause: { kind: 'BILLING', until: 'x' } } }).headline, /paused/u);
  // Only a real reply from a provider check the owner ran earns "working".
  const worked = chatCardSummary({ model, owner: true, governor: quiet, checks: [{ tone: TONE.GOOD }], checkedAt: '10:15' });
  assert.equal(worked.tone, TONE.GOOD); assert.equal(worked.detail, 'A provider check got a real reply at 10:15 UTC.');
  assert.equal(chatCardSummary({ model, owner: true, governor: quiet, checks: [{ tone: TONE.WARN }] }).tone, TONE.UNKNOWN);
  // Customers never see ledger detail, and owners keep the configuration reason.
  assert.doesNotMatch(chatCardSummary({ model, owner: false, governor: { failingModels: 3, recentFailureKinds: ['BILLING'] } }).detail, /credit|failed/u);
  assert.equal(chatCardSummary({ model: { configured: false, reason: 'Set the endpoint.' }, owner: true }).detail, 'Set the endpoint.');
  assert.match(chatCardSummary({ model: { configured: false, reason: 'PRIVATE' }, owner: false }).detail, /temporarily unavailable/u);
  assert.equal(chatCardSummary({ model: null, owner: true }).headline, 'Checking…');
});
