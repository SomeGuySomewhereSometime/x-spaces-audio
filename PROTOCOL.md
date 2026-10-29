# Protocol v1

The extension background holds one `{ endpoint, token }` pair in local extension storage. The endpoint is an HTTP origin on `127.0.0.1` or `localhost`. The random 32-byte token must never be sent to the X page.

## Local HTTP routes

| Method and path | Authentication | Response |
| --- | --- | --- |
| `GET /` | none | Local pairing page; capture is configured by the host application |
| `POST /api/x-audio/pair` | exact local same-origin `Origin` | `{ token }`; user triggers this from the pairing page |
| `GET /api/x-audio/control` | `Authorization: Bearer TOKEN` | `{ protocolVersion: 1, enabled, transcribe, room, epoch }` |
| `GET /api/x-audio/status` | bearer | `{ enabled, room, mode, state, tracks, activity }` |
| `POST /api/x-audio/event` | bearer | `{ accepted: true }`, `{ ignored: true, reason? }`, or `{ duplicate: true }` |

`transcribe` is a legacy wire name for **forward PCM segments**. It does not start transcription. Activity remains available when it is false. The default local bridge binds only `127.0.0.1`, validates the Host header, limits request bodies to 570,000 bytes and does not enable CORS. Pairing returns 403 for missing or foreign origins. Authenticated event validation errors return 400; invalid/missing bearer returns 401.

An alternative HTTP host must preserve these boundaries. Do not expose the pairing token in query strings or return it to the X page. The extension polls control every two seconds. Pair again after a server restart or token rotation.

## Window messages

On the local pairing page, send `{ channel: 'x-spaces-audio-pair', token }` with `window.postMessage(message, location.origin)`. Wait for `{ channel: 'x-spaces-audio-paired', ok }` from that same window and origin.

On X, the isolated relay sends `{ channel: 'x-spaces-audio-control', control }` to the page world and accepts `{ channel: 'x-spaces-audio-event', payload }`. Only the extension background performs bearer-authenticated HTTP requests. Window messages are not trusted authentication; they transport page-origin data, which must be validated by the local receiver.

## Browser events

All inputs include `type`, `room`, `epoch`, `source`. Room and epoch must match the active receiver session. `source` identifies the page capture (the relay heartbeat can have a separate ID). IDs are bounded strings of letters, digits, `_`, `-`, `:`. Unknown fields are not forwarded to consumers.

- `connector`: relay heartbeat. Confirms the extension reaches the application; does not prove track capture.
- `status`: `tracks` (integer 0–16), optional capture diagnostics. The standalone receiver accepts up to eight live page sources; the first with tracks is selected. Sources expire after ten seconds without status. Diagnostics are not forwarded by this minimal receiver.
- `activity`: `sequence`, `atMs`, `speakers`. Sequence increases per source/session. Each speaker has `feed`, `handle`, `displayName`, `startedAtMs`, `lastVoicedAtMs`. Events list the full active set, including overlaps. At most 16 unique feeds. Events expire after five seconds and must be recent when ingested. Replayed sequences are ignored.
- `segment`: `id`, `feed`, `handle`, `displayName`, `startedAtMs`, `endedAtMs`, `pcm`. PCM is base64 signed 16-bit little-endian mono at 16 kHz. Duration is positive and at most 13 seconds; end time must be within 30 seconds of ingestion. Decoded payload must have an even size, 3,200–416,000 bytes, consistent with duration within the validator's 1.2-second tolerance. Duplicate IDs are remembered in a bounded 1,024-entry set.

The standalone receiver accepts activity and segments only from the selected live source. The selected source must first send a nonzero status. Handles are normalized to lowercase; invalid or missing handles become empty strings. Display names are sanitized and cleared for unknown accounts. The capture's own normal chunk size is approximately eight seconds, below the receiver's upper bound.

## Consumer events

`SpacesAudioReceiver` is a Node.js `EventEmitter`:

- `activity`: `{ room, atMs, expiresAtMs, speakers, reason, sequence? }`. Signal updates have `reason: 'signal'`. Expiry, stop and reconfiguration can emit an empty set without a sequence. These events describe approximate activity, not attribution of specific words.
- `segment`: validated segment fields plus `source`, `sampleRate: 16000`, `channels: 1`, `encoding: 'pcm_s16le'`. Identity is the account mapped to that feed; it is not inferred from audio.
- `status`: the current snapshot. It contains neither the pairing token nor PCM.

Attach listeners before configuration. Application callbacks must handle their own failures; async listeners are not awaited. Bound your own downstream STT queues and cancel jobs on session changes. This receiver neither persists events nor guarantees delivery across failures.
