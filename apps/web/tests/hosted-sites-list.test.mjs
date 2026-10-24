import assert from 'node:assert/strict';
import test from 'node:test';
import { readHostedSites, siteStatusLabel, SITE_ID, toSite, updatedLabel } from '../app/build/hosted-sites-client.mjs';
import { PREVIEW_ID } from '../app/api/genesis/hosted-site.mjs';

const id = 'gen_11111111-1111-4111-8111-111111111111';

test('the list uses the same preview id rule as the preview route', () => {
  assert.equal(SITE_ID.source, PREVIEW_ID.source);
});

test('a project row keeps only name, status, time and its own preview link', () => {
  const site = toSite({ id, name: '  Bakery site  ', status: 'ready', updatedAt: '2026-10-20T10:00:00.000Z', previewUrl: `/preview/${id}`, prompt: 'PRIVATE prompt', requirements: { spec: 'PRIVATE' }, tenantId: 'PRIVATE' });
  assert.deepEqual(site, { id, name: 'Bakery site', status: 'ready', statusLabel: 'Preview ready', updatedAt: '2026-10-20T10:00:00.000Z', previewHref: `/preview/${id}` });
  assert.equal(toSite({ id, name: 'Planned', status: 'planned', previewUrl: null }).previewHref, null, 'nothing to open yet');
  assert.equal(toSite({ id, previewUrl: 'https://evil.example/' }).previewHref, null, 'a stored URL is never followed');
  assert.equal(toSite({ id: 'gen_../../admin', previewUrl: '/preview/gen_../../admin' }).previewHref, null);
  assert.equal(toSite({ id, name: '' }).name, 'Untitled website');
  assert.equal(toSite(null), null);
  assert.equal(siteStatusLabel('mystery'), 'In progress');
});

test('updated times read naturally', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  assert.equal(updatedLabel('2026-10-21T11:59:30Z', now), 'Updated just now');
  assert.equal(updatedLabel('2026-10-21T11:59:00Z', now), 'Updated 1 minute ago');
  assert.equal(updatedLabel('2026-10-21T09:00:00Z', now), 'Updated 3 hours ago');
  assert.equal(updatedLabel('2026-10-01T09:00:00Z', now), 'Updated Oct 1, 2026');
  assert.equal(updatedLabel('garbage', now), null);
});

test('the reader handles success, empty, signed out and failures without echoing server text', async () => {
  const calls = [];
  const reply = (status, body) => async (url, options) => { calls.push([url, options.cache]); return Response.json(body, { status }); };
  const ok = await readHostedSites({ fetcher: reply(200, { projects: [{ id, name: 'A', status: 'ready', previewUrl: `/preview/${id}` }, { nope: true }] }) });
  assert.equal(ok.sites.length, 1); assert.equal(ok.signedOut, false);
  assert.deepEqual(calls[0], ['/api/genesis/projects', 'no-store']);
  assert.deepEqual((await readHostedSites({ fetcher: reply(200, { projects: [] }) })).sites, []);
  assert.equal((await readHostedSites({ fetcher: reply(401, {}) })).signedOut, true);
  for (const fetcher of [reply(403, { message: 'PRIVATE tenant' }), reply(500, {}), reply(200, { projects: 'PRIVATE' })]) {
    await assert.rejects(readHostedSites({ fetcher }), error => !error.message.includes('PRIVATE'));
  }
});
