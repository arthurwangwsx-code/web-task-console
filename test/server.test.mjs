import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'web-console-http-'));
  const app = await startServer({ port: 0, dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${app.origin}/api/bootstrap`)).json();
  const post = (path, body = {}, headers = {}) => fetch(`${app.origin}${path}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Console-Token': bootstrap.csrfToken, ...headers }, body: JSON.stringify(body) });
  return { app, post };
}

test('HTTP only permits exact loopback host and same-origin authenticated mutations', async t => {
  const { app, post } = await fixture(t);
  assert.equal((await post('/api/tick', {}, { Origin: 'https://unapproved.example' })).status, 403);
  assert.equal((await post('/api/tick', {}, { 'X-Console-Token': 'bad' })).status, 403);
  assert.equal((await post('/api/tick', {}, { Origin: '' })).status, 403);
  assert.equal((await fetch(`${app.origin}/api/bootstrap`, { headers: { Origin: 'https://unapproved.example' } })).status, 403);
  assert.equal(await new Promise((resolve, reject) => http.get(`${app.origin}/api/state`, { headers: { Host: 'unapproved.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject)), 403);
});

test('HTTP validates bodies, routes and preserves engine error status codes', async t => {
  const { app, post } = await fixture(t);
  assert.equal((await post('/api/pause', { paused: 'false' })).status, 400);
  assert.equal((await post('/api/intents', { idempotencyKey: 'invalid key', prompt: 'synthetic' })).status, 400);
  assert.equal((await post('/api/intents', { idempotencyKey: 'long', prompt: 'a'.repeat(65536) })).status, 413);
  assert.equal((await post('/api/tick', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${app.origin}/src/runtime.mjs`)).status, 404);
  assert.equal((await fetch(`${app.origin}/%2e%2e/src/runtime.mjs`)).status, 404);
  assert.equal((await post('/api/intents/nonexistent/reconcile')).status, 404);
  const response = await fetch(app.origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('HTTP multiline enqueue does not dispatch; lost ACK remains protected until correlated read', async t => {
  const { app, post } = await fixture(t);
  const input = { idempotencyKey: 'http-multiline', prompt: 'first line\nsecond line\n第三行' };
  const queued = await (await post('/api/intents', input)).json();
  assert.equal(queued.dispatch.state, 'queued');
  assert.equal(app.runtime.adapter.state.sends, 0);
  assert.equal(queued.prompt, input.prompt);
  assert.equal((await (await post('/api/intents', input)).json()).id, queued.id);
  assert.equal((await post('/api/intents', { ...input, prompt: 'different payload' })).status, 409);
  await post('/api/scenario', { scenario: 'lost-ack' });
  await post('/api/tick');
  let state = await (await fetch(`${app.origin}/api/state`)).json();
  assert.equal(state.intents[0].dispatch.state, 'unknown');
  const tabId = state.tabs[0].id;
  assert.equal((await post(`/api/tabs/${tabId}/close`)).status, 409);
  await post('/api/tick');
  assert.equal(app.runtime.adapter.state.sends, 1);
  assert.equal((await fetch(`${app.origin}/api/state`)).status, 200);
  await post(`/api/intents/${queued.id}/reconcile`);
  state = await (await fetch(`${app.origin}/api/state`)).json();
  assert.equal(state.intents[0].completion.verified, true);
  assert.equal(state.intents[0].provider.state, 'succeeded');
  assert.equal((await (await post(`/api/tabs/${tabId}/close`)).json()).state, 'closed');
  assert.equal(app.runtime.adapter.state.sends, 1);
});

for (const idempotencyKey of ['constructor', '__proto__', 'toString']) {
  test(`HTTP legal prototype-like key ${idempotencyKey} sends once and recovers after disk restart`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'web-console-key-'));
    let app;
    const input = { idempotencyKey, prompt: `Synthetic key regression\n${idempotencyKey}` };
    async function connect() {
      app = await startServer({ port: 0, dataDir });
      const { csrfToken } = await (await fetch(`${app.origin}/api/bootstrap`)).json();
      return async (path, body = {}) => {
        const response = await fetch(`${app.origin}${path}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Console-Token': csrfToken }, body: JSON.stringify(body) });
        assert.ok(response.ok, `HTTP ${response.status} for ${path}`);
        return response.json();
      };
    }
    try {
      let post = await connect();
      // Missing jobs must not resolve to Object.prototype's inherited properties.
      assert.equal(await app.runtime.adapter.observe(input), null);
      assert.equal(Object.getPrototypeOf(app.runtime.adapter.state.jobs), null);
      assert.equal(Object.getPrototypeOf(app.runtime.adapter.state.tabs), null);
      const queued = await post('/api/intents', input);
      await post('/api/scenario', { scenario: 'lost-ack' });
      const dispatched = await post('/api/tick');
      assert.equal(dispatched.intent.dispatch.state, 'unknown');
      assert.equal(app.runtime.adapter.state.sends, 1);
      assert.equal(Object.hasOwn(app.runtime.adapter.state.jobs, idempotencyKey), true);
      await app.close();
      post = await connect();
      // JSON round trip must restore both own-key membership and null prototypes.
      assert.equal(Object.getPrototypeOf(app.runtime.adapter.state.jobs), null);
      assert.equal(Object.getPrototypeOf(app.runtime.adapter.state.tabs), null);
      assert.equal(Object.hasOwn(app.runtime.adapter.state.jobs, idempotencyKey), true);
      assert.equal((await post('/api/intents', input)).id, queued.id);
      await post('/api/tick');
      assert.equal(app.runtime.adapter.state.sends, 1);
      const observed = await post(`/api/intents/${queued.id}/reconcile`);
      assert.equal(observed.status, 'succeeded');
      assert.equal(observed.completion.verified, true);
      await post(`/api/tabs/${observed.tabId}/close`);
      assert.equal(app.runtime.engine.snapshot().metrics.active, 0);
      assert.equal(app.runtime.engine.snapshot().metrics.openTabs, 0);
      assert.equal(app.runtime.adapter.state.sends, 1);
      assert.equal(Object.hasOwn(Object.prototype, 'observationId'), false);
    } finally { await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
}
