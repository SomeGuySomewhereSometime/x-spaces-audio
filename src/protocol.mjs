export const validId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(value);
const cleanDisplayName = value => typeof value==='string'?value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,80):'';
export const activityLeaseMs = 5000;
export function validateTrackActivity(input, room, now = Date.now()) {
  if(!input||input.room!==room||!Number.isSafeInteger(input.sequence)||input.sequence<1||!Number.isFinite(input.atMs)||input.atMs>now+1000||now-input.atMs>activityLeaseMs||!Array.isArray(input.speakers)||input.speakers.length>16)throw new Error('Atividade de voz inválida.');
  const feeds=new Set();
  const speakers=input.speakers.map(s=>{
    if(!s||!validId(s.feed)||feeds.has(s.feed)||!Number.isFinite(s.startedAtMs)||!Number.isFinite(s.lastVoicedAtMs)||s.startedAtMs<0||s.startedAtMs>s.lastVoicedAtMs||s.lastVoicedAtMs>input.atMs+1000||input.atMs-s.lastVoicedAtMs>1500)throw new Error('Orador ativo inválido.');
    feeds.add(s.feed);
    const handle=typeof s.handle==='string'&&/^[A-Za-z0-9_]{1,15}$/.test(s.handle)?s.handle.toLowerCase():'';
    return {feed:s.feed,handle,displayName:handle?cleanDisplayName(s.displayName):'',startedAtMs:s.startedAtMs,lastVoicedAtMs:s.lastVoicedAtMs};
  });
  return {sequence:input.sequence,atMs:input.atMs,speakers};
}
export function validateAudioSegment(input, room, now = Date.now()) {
  if (!input || input.room !== room || !validId(input.feed) || !validId(input.id)) throw new Error('Faixa ou Space inválido.');
  const start = Number(input.startedAtMs), end = Number(input.endedAtMs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 13000 || Math.abs(now-end) > 30000) throw new Error('Intervalo de áudio inválido.');
  if (typeof input.pcm !== 'string' || input.pcm.length > 560000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.pcm)) throw new Error('Áudio inválido.');
  const pcm = Buffer.from(input.pcm, 'base64');
  if (pcm.length < 3200 || pcm.length > 416000 || pcm.length % 2 || Math.abs(pcm.length / 32 - (end-start)) > 1200) throw new Error('Duração do áudio inválida.');
  const handle = typeof input.handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(input.handle) ? input.handle.toLowerCase() : '';
  return { id: input.id, feed: input.feed, handle, displayName:handle?cleanDisplayName(input.displayName):'', room, startedAtMs: start, endedAtMs: end, pcm: input.pcm };
}
