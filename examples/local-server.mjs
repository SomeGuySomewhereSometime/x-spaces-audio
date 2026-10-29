import { SpacesAudioReceiver, createLocalBridge } from '../src/index.mjs';

const args = process.argv.slice(2);
const room = args.find(arg => !arg.startsWith('--'));
if (!room) {
  console.error('Usage: npm run example -- SPACE_ID [--audio]');
  process.exitCode = 1;
} else {
  const receiver = new SpacesAudioReceiver();
  receiver.configure({ room, mode: args.includes('--audio') ? 'audio' : 'activity' });
  receiver.on('activity', event => console.log('speakers:', event.speakers.map(person => person.handle || '(unknown)').join(', ') || '(silence)'));
  receiver.on('segment', segment => {
    // Connect your own STT callback here. No audio is logged or saved.
    console.log('audio:', segment.handle || '(unknown)', `${segment.endedAtMs - segment.startedAtMs} ms`, `${Buffer.from(segment.pcm, 'base64').length} bytes`);
  });
  const bridge = createLocalBridge({ receiver });
  console.log(`Pair extension at ${await bridge.listen()}`);
  console.log(`Mode: ${receiver.mode}. Stop with Ctrl+C.`);
  const stop = async () => { await bridge.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
