import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtension } from '../scripts/build-extension.mjs';

test('embedding applications can keep their existing channels and pairing storage', async t => {
  const target = await mkdtemp(join(tmpdir(), 'spaces-extension-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await buildExtension(target, { namespace: 'demo-audio', globalName: '__demoAudio', storageKey: 'demoAudio', name: 'Demo Audio' });
  assert.match(await readFile(join(target, 'capture.js'), 'utf8'), /demo-audio-control/);
  assert.match(await readFile(join(target, 'capture.js'), 'utf8'), /__demoAudio/);
  assert.match(await readFile(join(target, 'background.js'), 'utf8'), /demoAudio/);
  assert.equal(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')).name, 'Demo Audio');
  await assert.rejects(buildExtension(target, { namespace: 'invalid namespace' }));
});
