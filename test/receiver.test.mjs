import test from 'node:test';
import assert from 'node:assert/strict';
import { SpacesAudioReceiver } from '../src/index.mjs';

function fixture(t, mode = 'audio') {
  const receiver = new SpacesAudioReceiver();
  t.after(() => receiver.stop());
  receiver.configure({ room: 'space-a', mode });
  const event = overrides => ({ room: receiver.room, epoch: receiver.epoch, source: 'tab-a', ...overrides });
  receiver.ingest(event({ type: 'status', tracks: 2 }));
  const segment = overrides => event({ type: 'segment', id: 'chunk-1', feed: '100', handle: 'Ana', displayName: 'Ana Silva', startedAtMs: Date.now() - 1000, endedAtMs: Date.now(), pcm: Buffer.alloc(32000).toString('base64'), ...overrides });
  const activity = overrides => event({ type: 'activity', sequence: 1, atMs: Date.now(), speakers: [{ feed: '100', handle: 'Ana', displayName: 'Ana Silva', startedAtMs: Date.now() - 200, lastVoicedAtMs: Date.now() }], ...overrides });
  return { receiver, event, segment, activity };
}

test('PCM and identity are usable without STT, Python, X cookies or any application', t => {
  const { receiver, segment } = fixture(t);
  const chunks = [];
  receiver.on('segment', chunk => chunks.push(chunk));
  assert.deepEqual(receiver.ingest(segment()), { accepted: true });
  assert.equal(chunks[0].handle, 'ana');
  assert.equal(chunks[0].displayName, 'Ana Silva');
  assert.equal(chunks[0].sampleRate, 16000);
  assert.equal(chunks[0].encoding, 'pcm_s16le');
  assert.equal(Buffer.from(chunks[0].pcm, 'base64').length, 32000);
  assert.deepEqual(receiver.ingest(segment()), { duplicate: true });
  assert.equal(chunks.length, 1);
});

test('one active tab supplies audio and activity; stale tabs yield to the next', t => {
  const { receiver, event, segment, activity } = fixture(t);
  receiver.ingest(event({ type: 'status', tracks: 2, source: 'tab-b' }));
  assert.equal(receiver.ingest(segment({ source: 'tab-b' })).ignored, true);
  assert.equal(receiver.ingest(activity({ source: 'tab-b' })).ignored, true);
  const now = Date.now();
  receiver.sources.get('tab-a').at = now - 11000;
  receiver.refresh(now);
  assert.equal(receiver.selectedSource(), 'tab-b');
  assert.equal(receiver.ingest(segment({ source: 'tab-b' })).accepted, true);
});

test('activity expires, rejects replays and malformed identities, and never emits PCM in activity mode', t => {
  const { receiver, segment, activity } = fixture(t, 'activity');
  const updates = [];
  receiver.on('activity', event => updates.push(event));
  receiver.on('segment', () => assert.fail('No audio in activity mode'));
  assert.equal(receiver.control().transcribe, false);
  assert.equal(receiver.ingest(segment()).reason, 'activity_only');
  receiver.ingest(activity());
  assert.equal(updates[0].speakers[0].handle, 'ana');
  assert.equal(receiver.ingest(activity()).duplicate, true);
  assert.throws(() => receiver.ingest(activity({ sequence: 2, speakers: [{ feed: '100' }] })));
  receiver.refresh(Date.now() + 6000);
  assert.deepEqual(updates.at(-1).speakers, []);
  assert.equal(updates.at(-1).reason, 'expired');
});

test('Space/session changes and stop reject old input and clear active speakers', t => {
  const { receiver, segment, activity } = fixture(t);
  const oldSegment = segment();
  const cleared = [];
  receiver.on('activity', event => cleared.push(event));
  receiver.ingest(activity());
  receiver.configure({ room: 'space-b' });
  assert.deepEqual(cleared.at(-1).speakers, []);
  assert.equal(receiver.ingest(oldSegment).ignored, true);
  receiver.stop();
  assert.equal(receiver.control().enabled, false);
  assert.equal(receiver.ingest(oldSegment).ignored, true);
});

test('unknown identities stay unknown and invalid PCM, timing and floods are rejected', t => {
  const { receiver, segment, event } = fixture(t);
  const chunks = [];
  receiver.on('segment', chunk => chunks.push(chunk));
  receiver.ingest(segment({ handle: '', displayName: 'untrusted name' }));
  assert.equal(chunks[0].handle, '');
  assert.equal(chunks[0].displayName, '');
  assert.throws(() => receiver.ingest(segment({ id: 'bad', pcm: 'bad!' })));
  assert.throws(() => receiver.ingest(segment({ id: 'late', endedAtMs: Date.now() - 60000 })));
  assert.throws(() => receiver.ingest(event({ type: 'status', tracks: NaN })));
  for (let i = 1; i < 8; i++) receiver.ingest(event({ type: 'status', tracks: 0, source: `tab-${i}` }));
  assert.throws(() => receiver.ingest(event({ type: 'status', tracks: 0, source: 'tab-extra' })));
});
