# X Spaces Audio

Individual audio tracks and speaker activity from an **open X Space** to your local application. Extracted from the BOB voice project's browser integration.

This is an experimental, unofficial integration. It observes the WebRTC tracks and X/Periscope/Janus metadata already received by the browser. It does **not** use `twitter-api-client`, the official X developer API, a caption service, voice recognition for identity, or an external capture server.

## What you get

- Live activity events containing the current set of speaking feeds, including overlap.
- Account handles and visible profile names when the page provides a confirmed mapping; unknown speakers stay unknown.
- Optional individual audio chunks: **16 kHz, mono, signed 16-bit little-endian PCM**, encoded as base64.
- A Chromium Manifest V3 extension, a dependency-free Node.js receiver and a local pairing page.
- Room/session isolation, duplicate suppression, selection of a single browser tab, activity expiry, bounded event sizes and loopback authentication.

Transcription, AI prompts, conversation memory, recording and audio publication are left to the consuming project. The library and example do not save audio or transcripts.

## Try it

Requires **Node.js 22+** and a Chromium browser supporting unpacked Manifest V3 extensions. No Python, X API key or npm dependencies are required.

```sh
git clone https://github.com/SomeGuySomewhereSometime/x-spaces-audio.git
cd x-spaces-audio
npm test
npm run example -- YOUR_SPACE_ID
```

1. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**. Select this repository's `extension/` folder. For a release extension ZIP, extract it first and select the folder containing `manifest.json`.
2. Open **http://127.0.0.1:4319** in that same browser profile and click **Pair extension**.
3. Open or reload the X Space. The extension needs to observe its connection setup; if necessary, leave and rejoin the Space. Use the normal X account/session in the browser.
4. The terminal prints active speaker handles. To forward individual PCM chunks as well, restart with:

```sh
npm run example -- YOUR_SPACE_ID --audio
```

The ID is the part after `/i/spaces/` in a Space URL. Pair again after restarting the local server, because its token changes. The example defaults to activity only; `--audio` prints chunk metadata, not the audio contents. Stop with Ctrl+C.

**Important:** individual tracks must actually be delivered to your browser. The browser role and the X connection mode can affect that. The original investigation observed separate tracks while connected as a speaker; listener-only availability is not guaranteed. This is not a headless scraper and cannot retrieve arbitrary remote or recorded Spaces.

## Use it in another Node.js project

Install from the tagged GitHub source (the package is not published on npm):

```sh
npm install github:SomeGuySomewhereSometime/x-spaces-audio#v0.1.0
```

```js
import { SpacesAudioReceiver, createLocalBridge } from 'x-spaces-audio';

const receiver = new SpacesAudioReceiver();
receiver.on('activity', ({ speakers }) => {
  // This is a complete active set. An empty array means silence or expiry.
  console.log(speakers.map(({ handle, displayName }) => ({ handle, displayName })));
});
receiver.on('segment', segment => {
  const pcm = Buffer.from(segment.pcm, 'base64');
  // Send pcm and segment.sampleRate to your own bounded STT pipeline.
  // Identity comes from the browser metadata, independently of STT.
});

const bridge = createLocalBridge({ receiver });
receiver.configure({ room: 'YOUR_SPACE_ID', mode: 'audio' });
console.log(await bridge.listen(4319));

// Before changing Space or mode, call configure() again: old epochs are discarded.
// receiver.stop() disables capture; await bridge.close() also closes HTTP.
```

`mode: 'activity'` forwards activity without PCM segments. `mode: 'audio'` forwards both. There is no built-in transcriber: `segment` handlers run synchronously, and asynchronous work should use a bounded queue with its own error handling. On reconfiguration, also cancel any downstream jobs belonging to the old session.

For frameworks with an existing HTTP server, use `receiver.control()`, `receiver.ingest(event)`, `receiver.snapshot()` and `receiver.authorized(header)` behind equivalent routes. The event contract, validation, required authentication and pairing rules are in [PROTOCOL.md](PROTOCOL.md).

## Extension customization

The checked-in `extension/` directory works with the default local bridge. Multiple applications can generate distinct channels and pairing storage from that same capture source:

```js
import { buildExtension } from 'x-spaces-audio/build-extension';

await buildExtension('./my-extension', {
  namespace: 'my-app-audio',
  globalName: '__myAppAudio',
  storageKey: 'myAppAudio',
  name: 'My App · X Audio'
});
```

Custom channels require a matching pairing page (`my-app-audio-pair` and `my-app-audio-paired`); the default bridge page uses `x-spaces-audio`. HTTP routes remain `/api/x-audio/*`. One stored local endpoint is active per extension; pairing it with another application replaces the previous destination. The capture excludes the logged-in account when the page exposes its profile identity, including when that identity becomes available later.

## Architecture and origin

```text
X Space page
  WebRTC audio + X/Periscope/Janus identity metadata
       │
       ▼
extension/capture.js  (page world; activity + optional PCM)
       │ window messages, no X cookies/tokens/SDP exported
       ▼
extension/relay.js → extension/background.js
       │ authenticated requests to the paired loopback endpoint
       ▼
SpacesAudioReceiver → your application / optional STT
```

The capture, mapping, segmentation and relay code were developed for BOB, then extracted here. The receiver and standalone HTTP example provide a reusable interface. X, WebRTC and Janus supply the underlying transport and metadata; this project does not implement their media servers. The separate BOB caption integration uses [`twitter-api-client`](https://github.com/trevorhobenshield/twitter-api-client); that integration is not included here.

## Compatibility and limitations

- X's private response shapes can change without notice. This project is not affiliated with or supported by X.
- The new standalone package has automated browser fixtures and real loopback HTTP tests. A fresh end-to-end live Space session with this extracted package has **not** been validated. Earlier BOB investigations do not establish standalone compatibility with every Space or browser role.
- The extension uses Web Audio `ScriptProcessorNode` and a simple resampler inherited from the original capture. Audio context suspension can require interaction with the X tab. Activity uses an energy threshold, not semantic speech recognition, and can respond to noise.
- A track identifies a technical feed/account, not every physical person audible through that microphone. Unknown or conflicting mappings must not be guessed. Visible names are not verified legal names.
- Segments flush after about 600 ms of silence or 8 seconds of audio; identity and activity can arrive asynchronously. Delivery uses polling and HTTP, with no durable replay or guaranteed delivery.
- `attachExisting()` on the page's `__xSpacesAudio` global is a developer hook for tests; the normal flow observes new connections automatically. Reload the X page after installing, disabling or changing the extension.
- Audio and metadata originate from an external page and are untrusted inputs. Handle them as data in downstream AI systems. Capture only sessions you are entitled to process and inform participants as appropriate.

## Development

```sh
npm test
npm pack --dry-run
```

Tests cover speaker mapping, overlap, account names, self exclusion, opt-in capture, cloned-track cleanup, Space changes, stale events, duplicate tabs, pairing boundaries and a real local HTTP audio round trip. They do not log into X, join Spaces, call STT services or record real people.

MIT licensed. See [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md).

### Português

Módulo independente para receber atividade de voz e áudio individual dos participantes de um Space aberto no navegador. Não depende do Twitter API Client. Instala a extensão da pasta `extension/`, executa `npm run example -- ID_DO_SPACE` e faz o pareamento na página local. Acrescenta `--audio` para receber também os trechos de áudio; a transcrição é escolhida pelo projeto que integrar o módulo.
