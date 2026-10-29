import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { validId, activityLeaseMs, validateAudioSegment, validateTrackActivity } from './protocol.mjs';

const sourceLeaseMs = 10000;

/** Receives metadata and 16 kHz mono PCM. No transcription, persistence or X login. */
export class SpacesAudioReceiver extends EventEmitter {
  constructor() {
    super();
    this.token = randomBytes(32).toString('hex');
    this.sources = new Map();
    this.seen = new Set();
    this.sequences = new Map();
    this.enabled = false;
    this.room = '';
    this.epoch = '';
    this.mode = 'activity';
  }

  authorized(header) {
    const supplied = Buffer.from(String(header || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  configure({ room, mode = 'activity' }) {
    if (!validId(room)) throw new Error('Invalid Space ID. Supply the ID, not a URL.');
    if (!['activity', 'audio'].includes(mode)) throw new Error('Mode must be activity or audio.');
    this.stop('reconfigured');
    this.room = room;
    this.mode = mode;
    this.epoch = randomUUID();
    this.enabled = true;
    this.timer = setInterval(() => this.refresh(), 1000);
    this.timer.unref();
    this.emit('status', this.snapshot());
  }

  control() {
    // `transcribe` is the wire flag for forwarding audio segments, not an STT service.
    return { protocolVersion: 1, enabled: this.enabled, transcribe: this.enabled && this.mode === 'audio', room: this.room, epoch: this.epoch };
  }

  selectedSource(now = Date.now()) {
    return [...this.sources].find(([, source]) => source.tracks > 0 && now - source.at < sourceLeaseMs)?.[0];
  }

  snapshot() {
    const source = this.selectedSource();
    return { enabled: this.enabled, room: this.room, mode: this.mode, state: !this.enabled ? 'disabled' : source ? 'connected' : 'waiting', tracks: source ? this.sources.get(source).tracks : 0, activity: this.activity ? { atMs: this.activity.atMs, expiresAtMs: this.activity.expiresAtMs, speakers: this.activity.speakers } : null };
  }

  clearActivity(reason, now = Date.now()) {
    if (!this.activity) return;
    const hadSpeakers = this.activity.speakers.length > 0;
    this.activity = null;
    if (hadSpeakers) this.emit('activity', { room: this.room, atMs: now, expiresAtMs: now, speakers: [], reason });
  }

  refresh(now = Date.now()) {
    for (const [id, source] of this.sources) {
      if (now - source.at >= sourceLeaseMs) { this.sources.delete(id); this.sequences.delete(id); }
    }
    if (this.activity && (now >= this.activity.expiresAtMs || this.selectedSource(now) !== this.activity.source)) this.clearActivity('expired', now);
    this.emit('status', this.snapshot());
  }

  ingest(input) {
    if (!this.enabled || !input || input.epoch !== this.epoch || input.room !== this.room) return { ignored: true };
    if (!validId(input.source)) throw new Error('Invalid connector ID.');
    if (input.type === 'connector') return { accepted: true };
    if (input.type === 'status') {
      if (!Number.isInteger(input.tracks) || input.tracks < 0 || input.tracks > 16) throw new Error('Invalid track count.');
      if (this.sources.size >= 8 && !this.sources.has(input.source)) throw new Error('Too many connected tabs.');
      this.sources.set(input.source, { tracks: input.tracks, at: Date.now() });
      this.refresh();
      return { accepted: true };
    }
    if (!['activity', 'segment'].includes(input.type)) throw new Error('Unknown event type.');
    if (this.selectedSource() !== input.source) return { ignored: true, reason: 'inactive_source' };
    if (input.type === 'activity') {
      const activity = validateTrackActivity(input, this.room);
      if (activity.sequence <= (this.sequences.get(input.source) || 0)) return { duplicate: true };
      this.sequences.set(input.source, activity.sequence);
      this.activity = { ...activity, source: input.source, expiresAtMs: activity.atMs + activityLeaseMs };
      this.emit('activity', { ...activity, room: this.room, expiresAtMs: this.activity.expiresAtMs, reason: 'signal' });
      return { accepted: true };
    }
    if (this.mode !== 'audio') return { ignored: true, reason: 'activity_only' };
    const segment = validateAudioSegment(input, this.room);
    if (this.seen.has(segment.id)) return { duplicate: true };
    this.seen.add(segment.id);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value);
    this.emit('segment', { ...segment, source: input.source, sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' });
    return { accepted: true };
  }

  stop(reason = 'disabled') {
    clearInterval(this.timer);
    this.clearActivity(reason);
    this.enabled = false;
    this.room = '';
    this.epoch = '';
    this.sources.clear();
    this.sequences.clear();
    this.seen.clear();
    this.emit('status', this.snapshot());
  }
}
