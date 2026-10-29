import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createLocalBridge } from '../src/index.mjs';

test('real HTTP pairs only same-origin, authenticates events and delivers attributed audio', async t => {
  const bridge = createLocalBridge();
  t.after(() => bridge.close());
  const url = await bridge.listen(0);
  const request = (path, options) => fetch(url + path, options);
  assert.match(await (await request('/')).text(), /Pair extension/);
  assert.equal((await request('/api/x-audio/control')).status, 401);
  for (const origin of [undefined, 'https://x.com', 'http://evil.test']) {
    assert.equal((await request('/api/x-audio/pair', { method: 'POST', headers: origin ? { Origin: origin } : {} })).status, 403);
  }
  const pair = await request('/api/x-audio/pair', { method: 'POST', headers: { Origin: url } });
  const { token } = await pair.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal(bridge.receiver.authorized('Bearer wrong'), false);
  bridge.receiver.configure({ room: 'space-a', mode: 'audio' });
  const control = await (await request('/api/x-audio/control', { headers })).json();
  assert.equal(control.transcribe, true);
  assert.equal(JSON.stringify(control).includes(token), false);
  const post = input => request('/api/x-audio/event', { method: 'POST', headers, body: JSON.stringify({ room: 'space-a', epoch: control.epoch, source: 'browser-a', ...input }) });
  assert.equal((await post({ type: 'status', tracks: 1 })).status, 200);
  const received = [];
  bridge.receiver.on('segment', segment => received.push(segment));
  const segment = { type: 'segment', id: 'audio-1', feed: '100', handle: 'Ana', startedAtMs: Date.now() - 1000, endedAtMs: Date.now(), pcm: Buffer.alloc(32000).toString('base64') };
  assert.equal((await post(segment)).status, 200);
  assert.equal(received[0].handle, 'ana');
  assert.equal((await (await post(segment)).json()).duplicate, true);
  assert.equal((await post({ type: 'segment', pcm: 'invalid' })).status, 400);
  assert.equal((await request('/api/x-audio/event', { method: 'POST', headers, body: 'x'.repeat(570001) })).status, 400);
  const status = await (await request('/api/x-audio/status', { headers })).json();
  assert.equal(status.state, 'connected');
  assert.equal(JSON.stringify(status).includes(token), false);
  assert.equal((await request('/api/x-audio/nope', { headers })).status, 404);
  const forbidden = await new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: 'attacker.test', Origin: 'http://attacker.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(forbidden, 403);
});

test('local speaker view shows overlap safely and clears expired or disconnected speakers', async t => {
  const bridge = createLocalBridge();
  t.after(() => bridge.close());
  const url = await bridge.listen(0);
  const html = await (await fetch(url)).text();
  const nodes = new Map();
  const element = () => ({ textContent: '', children: [], append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  for (const id of ['status', 'connection', 'speakers', 'pair']) nodes.set(id, element());
  let snapshot = { state: 'connected', tracks: 2, mode: 'activity', activity: { expiresAtMs: Date.now() + 5000, speakers: [{ handle: 'demo_one', displayName: '<img src=x>', feed: '100' }, { handle: '', feed: '200' }] } };
  let unavailable = false;
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: element },
    window: { addEventListener() {}, postMessage() {} }, location: { origin: url },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, AbortSignal, Date,
    fetch: async path => {
      if (unavailable) throw new Error('offline');
      return { ok: true, json: async () => path.endsWith('/pair') ? { token: 'a'.repeat(64) } : snapshot };
    }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await nodes.get('pair').onclick();
  await context.poll();
  assert.deepEqual(nodes.get('speakers').children.map(node => node.textContent), ['<img src=x> (@demo_one)', 'Unknown speaker (feed 200)']);
  snapshot.activity.expiresAtMs = Date.now() - 1;
  await context.poll();
  assert.equal(nodes.get('speakers').children[0].textContent, 'No voice activity detected.');
  unavailable = true;
  await context.poll();
  assert.equal(nodes.get('speakers').children.length, 0);
  assert.match(nodes.get('connection').textContent, /unavailable/);
});
