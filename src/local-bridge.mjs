import { createServer } from 'node:http';
import { SpacesAudioReceiver } from './receiver.mjs';

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>X Spaces Audio</title>
<style>body{font:18px system-ui;max-width:650px;margin:4rem auto;padding:1rem;line-height:1.6}button{font:inherit;padding:.7rem}pre{white-space:pre-wrap}</style>
<h1>X Spaces Audio</h1><p>Load the extension, then pair it with this local application. Open or reload your X Space afterwards. Capture is controlled by the application running this server.</p>
<button id="pair">Pair extension</button><pre id="status" role="status">Not paired.</pre>
<script>
const status=document.getElementById('status');let waiting=false,timer;
window.addEventListener('message',event=>{if(waiting&&event.source===window&&event.origin===location.origin&&event.data?.channel==='x-spaces-audio-paired'){waiting=false;clearTimeout(timer);status.textContent=event.data.ok?'Paired. Open or reload the X Space in this browser profile.':'Pairing failed.';}});
document.getElementById('pair').onclick=async()=>{try{const response=await fetch('/api/x-audio/pair',{method:'POST'});if(!response.ok)throw new Error();const {token}=await response.json();waiting=true;clearTimeout(timer);status.textContent='Waiting for extension…';timer=setTimeout(()=>{waiting=false;status.textContent='Extension did not respond. Load extension/ and reload this page.';},4000);window.postMessage({channel:'x-spaces-audio-pair',token},location.origin);}catch{status.textContent='Local pairing failed.';}};
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
