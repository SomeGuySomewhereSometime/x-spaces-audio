import { createServer } from 'node:http';
import { SpacesAudioReceiver } from './receiver.mjs';

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>X Spaces Audio</title>
<style>body{font:18px system-ui;max-width:700px;margin:4rem auto;padding:1rem;line-height:1.6;color:#182a35;background:#f6fafb}button{font:inherit;padding:.7rem 1rem;border:0;border-radius:.5rem;background:#075e65;color:white;cursor:pointer}pre{white-space:pre-wrap}section{background:white;padding:1.4rem;border:1px solid #dce6e8;border-radius:1rem;margin-top:2rem}li{padding:.5rem 0}small{color:#50646e}</style>
<h1>X Spaces Audio</h1><p>Separate audio tracks, account handles and active speakers from an open X Space.</p><p>Load the extension, then pair it with this local application. Open or reload your X Space afterwards. Capture is controlled by the application running this server.</p>
<button id="pair">Pair extension</button><pre id="status" role="status">Not paired.</pre>
<section><h2>Speaking now</h2><p id="connection">Waiting for pairing.</p><ul id="speakers" aria-live="polite"></ul><small>Activity is approximate. Multiple entries indicate overlap; an unknown feed stays unknown.</small></section>
<script>
const status=document.getElementById('status'),connection=document.getElementById('connection'),speakers=document.getElementById('speakers');let waiting=false,timer,sessionToken='',polling=false;
async function poll(){
  if(!sessionToken||polling)return;
  polling=true;
  try{
    const response=await fetch('/api/x-audio/status',{headers:{Authorization:'Bearer '+sessionToken},signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error();
    const state=await response.json();
    connection.textContent=state.state+' · '+state.tracks+' track(s) · '+state.mode;
    const active=state.activity&&state.activity.expiresAtMs>Date.now()?state.activity.speakers:[];
    speakers.replaceChildren();
    for(const person of active){const item=document.createElement('li');item.textContent=person.handle?(person.displayName?person.displayName+' (@'+person.handle+')':'@'+person.handle):'Unknown speaker (feed '+person.feed+')';speakers.append(item);}
    if(!active.length){const item=document.createElement('li');item.textContent=state.state==='connected'?'No voice activity detected.':'Waiting for audio tracks from the X tab.';speakers.append(item);}
  }catch{connection.textContent='Local server unavailable. Pair again after a restart.';speakers.replaceChildren();}
  finally{polling=false;}
}
setInterval(poll,1000);
window.addEventListener('message',event=>{if(waiting&&event.source===window&&event.origin===location.origin&&event.data?.channel==='x-spaces-audio-paired'){waiting=false;clearTimeout(timer);status.textContent=event.data.ok?'Paired. Open or reload the X Space in this browser profile.':'Pairing failed.';if(event.data.ok)void poll();}});
document.getElementById('pair').onclick=async()=>{try{const response=await fetch('/api/x-audio/pair',{method:'POST'});if(!response.ok)throw new Error();const {token}=await response.json();sessionToken=token;waiting=true;clearTimeout(timer);status.textContent='Waiting for extension…';timer=setTimeout(()=>{waiting=false;status.textContent='Extension did not respond. Load extension/ and reload this page.';},4000);window.postMessage({channel:'x-spaces-audio-pair',token},location.origin);}catch{status.textContent='Local pairing failed.';}};
</script></html>`;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 570000) throw new Error('Event too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** A loopback-only HTTP server; pairing tokens never enter the X page. */
export function createLocalBridge({ receiver = new SpacesAudioReceiver() } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(req.headers.host)) { send(res, 403, { error: 'Invalid local host.' }); return; }
      const path = req.url;
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }).end(page);
        return;
      }
      if (path === '/api/x-audio/pair' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}`) { send(res, 403, { error: 'Pair from the local application page.' }); return; }
        send(res, 200, { token: receiver.token }); return;
      }
      if (!receiver.authorized(req.headers.authorization)) { send(res, 401, { error: 'Pair the extension again.' }); return; }
      if (path === '/api/x-audio/control' && req.method === 'GET') { send(res, 200, receiver.control()); return; }
      if (path === '/api/x-audio/status' && req.method === 'GET') { send(res, 200, receiver.snapshot()); return; }
      if (path === '/api/x-audio/event' && req.method === 'POST') { send(res, 200, receiver.ingest(await readJson(req))); return; }
      send(res, 404, { error: 'Unknown route.' });
    } catch {
      if (!res.headersSent && !res.destroyed) send(res, 400, { error: 'Invalid audio event.' });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return {
    receiver,
    server,
    async listen(port = 4319) {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      receiver.stop();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
