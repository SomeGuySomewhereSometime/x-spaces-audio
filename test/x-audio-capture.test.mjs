import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function fixture(){
  const sent=[],processors=[],clones=[],listeners={};let contexts=0,response={},now=Date.now();
  class Clock extends Date { static now(){return now;} }
  const window={location:null,addEventListener:(type,fn)=>{(listeners[type]??=[]).push(fn);},postMessage:message=>sent.push(message)};
  const track=id=>({id,kind:'audio',readyState:'live',clone(){const c={stopped:false,stop(){this.stopped=true;},addEventListener(){}};clones.push(c);return c;}});
  class Peer{constructor(){this.connectionState='connected';this.transceivers=[];}getTransceivers(){return this.transceivers;}async setRemoteDescription(d){this.remoteDescription={...d,sdp:d.sdp.replace(/\r\n/g,'\n').trim()};}}
  class XHR{open(){}addEventListener(){}}
  const node=()=>({connect(){},disconnect(){}});
  class Audio{constructor(){contexts++;this.state='running';}createMediaStreamSource(){return node();}createScriptProcessor(){const p=node();processors.push(p);return p;}createGain(){return {...node(),gain:{value:1}};}async close(){this.state='closed';}async resume(){this.state='running';}}
  const location={origin:'https://x.com',hostname:'x.com',protocol:'https:'};window.location=location;
  window.fetch=async()=>({url:'https://guest.pscp.tv/api/v1/audiospace/call/status',clone(){return{json:async()=>response}}});
  const ctx=vm.createContext({window,location,crypto:{randomUUID},XMLHttpRequest:XHR,RTCPeerConnection:Peer,AudioContext:Audio,MediaStream:class{},document:{querySelector:()=>({getAttribute:()=>'/DemoAccount'})},URL,Map,Set,Date:Clock,Float32Array,Uint8Array,DataView,Math,btoa:s=>Buffer.from(s,'binary').toString('base64')});
  vm.runInContext(readFileSync(new URL('../extension/capture.js',import.meta.url),'utf8'),ctx);
  const control=m=>listeners.message.forEach(fn=>fn({source:window,origin:location.origin,data:{channel:'x-spaces-audio-control',control:m}}));
  const add=(room,feeds)=>{const pc=new Peer();pc.transceivers=feeds.map((f,i)=>({mid:String(i),currentDirection:'recvonly',receiver:{track:track('track-'+room+'-'+f.feed)}}));window.__xSpacesAudio.attachExisting(pc,{room,streams:feeds.map((f,i)=>({mid:String(i),type:'audio',feed_id:f.feed,active:true}))},feeds);return pc;};
  const process=(index,value,sampleRate=16000)=>{const raw=new Float32Array(4096);for(let i=0;i<raw.length;i++)raw[i]=value*Math.sin(i*0.1);now+=raw.length/sampleRate*1000;processors[index].onaudioprocess?.({inputBuffer:{sampleRate,getChannelData:()=>raw}});};
  const native=()=>{const pc=new window.RTCPeerConnection();pc.transceivers=[{mid:'0',currentDirection:'recvonly',receiver:{track:track('native-track')}}];return pc;};
  return {window,sent,processors,clones,control,add,native,process,advance:ms=>{now+=ms;},contexts:()=>contexts,setResponse:async value=>{response=value;await window.fetch('');await new Promise(r=>setImmediate(r));}};
}
test('capture is opt-in, keeps individual feed attribution and never stops original tracks',()=>{
  const f=fixture();f.add('space-a',[{feed:'100',handle:'ana'},{feed:'200',handle:'bruno'},{feed:'300',handle:'DemoAccount'}]);assert.equal(f.contexts(),0);
  f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(f.processors.length,2);
  for(let i=0;i<3;i++){f.process(0,.08);f.process(1,.12);}for(let i=0;i<3;i++){f.process(0,0);f.process(1,0);}
  const segments=f.sent.filter(x=>x.payload?.type==='segment').map(x=>x.payload);
  assert.equal(segments.length,2);assert.deepEqual(segments.map(x=>[x.feed,x.handle]),[['100','ana'],['200','bruno']]);assert.ok(segments.every(x=>x.room==='space-a'&&x.epoch==='one'&&Buffer.from(x.pcm,'base64').length>3200));
  f.control({enabled:false});assert.ok(f.clones.every(c=>c.stopped));assert.ok(f.processors.every(p=>p.onaudioprocess===null));
});
test('switching Space releases old clones and a new feed map is required',()=>{
  const f=fixture();f.add('space-a',[{feed:'100',handle:'ana'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  f.control({enabled:true,epoch:'two',room:'space-b'});assert.equal(f.clones[0].stopped,true);assert.equal(f.processors.length,1);
  f.add('space-b',[{feed:'200',handle:'bruno'}]);assert.equal(f.processors.length,2);
  f.control({enabled:false});
});
test('observes the official Janus offer and binds it to a later remote description',async()=>{
  const f=fixture();await f.setResponse({sender:42,plugindata:{data:{room:'space-a',streams:[{mid:'0',type:'audio',feed_id:'100'}]}},jsep:{sdp:'offer'}});
  const pc=f.add('space-a',[{feed:'100',handle:'ana'}]);await pc.setRemoteDescription({type:'offer',sdp:'offer'});
  f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(f.processors.length,1);f.control({enabled:false});
});
test('maps the host through public GraphQL periscope identity even without a guest-session record',async()=>{
  const f=fixture();await f.setResponse({participants:{admins:[{periscope_user_id:'host-periscope',twitter_screen_name:'host_account'}]}});
  await f.setResponse({plugindata:{data:{room:'space-a',publishers:[{id:'400',display:'host-periscope'}]}}});
  f.add('space-a',[{feed:'400'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  for(let i=0;i<3;i++)f.process(0,.1);for(let i=0;i<3;i++)f.process(0,0);
  assert.equal(f.sent.find(x=>x.payload?.type==='segment').payload.handle,'host_account');f.control({enabled:false});
});
test('automatically discovers a native peer when the Janus offer arrives after the browser normalizes SDP',async()=>{
  const f=fixture(),pc=f.native();await pc.setRemoteDescription({type:'offer',sdp:'v=0\r\na=mid:0\r\n'});
  await f.setResponse({sender:42,plugindata:{data:{room:'space-a',streams:[{mid:'0',type:'audio',feed_id:'100'}]}},jsep:{sdp:'v=0\r\na=mid:0\r\n'}});
  f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(f.processors.length,1);
  const diagnostics=f.sent.filter(x=>x.payload?.type==='status').at(-1).payload.diagnostics;assert.equal(diagnostics.peers,1);assert.equal(diagnostics.matchingPeers,1);assert.equal(diagnostics.offers,1);f.control({enabled:false});
});
test('native constructor tracking survives a later replacement of setRemoteDescription',async()=>{
  const f=fixture(),pc=f.native();pc.setRemoteDescription=async d=>{pc.remoteDescription=d;};
  await f.setResponse({sender:42,plugindata:{data:{room:'space-a',streams:[{mid:'0',type:'audio',feed_id:'100'}]}},jsep:{sdp:'offer'}});
  await pc.setRemoteDescription({type:'offer',sdp:'offer'});f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(f.processors.length,1);f.control({enabled:false});
});
test('announces voice before transcription, ignores short noise, and holds activity across short pauses',()=>{
  const f=fixture();f.add('space-a',[{feed:'100',handle:'ana'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  const events=()=>f.sent.filter(x=>x.payload?.type==='activity').map(x=>x.payload);
  f.process(0,.1,48000);f.process(0,0,48000);assert.equal(events().filter(e=>e.speakers.length).length,0);
  f.process(0,.1,48000);f.process(0,.1,48000);
  assert.equal(events().at(-1).speakers[0].handle,'ana');assert.equal(f.sent.filter(x=>x.payload?.type==='segment').length,0);
  const start=events().at(-1).speakers[0].startedAtMs;
  f.process(0,0,48000);f.process(0,0,48000);f.process(0,.1,48000);assert.equal(events().filter(e=>e.speakers.length).length,1);
  f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(events().at(-1).speakers[0].startedAtMs,start);
  for(let i=0;i<8;i++)f.process(0,0,48000);
  assert.equal(events().at(-1).speakers.length,0);assert.equal(f.sent.filter(x=>x.payload?.type==='segment').length,1);f.control({enabled:false});
});
test('overlap is a full active set, chunk boundaries do not end speech, and lost input clears it',()=>{
  const f=fixture();f.add('space-a',[{feed:'100',handle:'ana'},{feed:'200',handle:'bruno'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  const events=()=>f.sent.filter(x=>x.payload?.type==='activity').map(x=>x.payload);
  f.process(0,.1);f.process(1,.1);assert.deepEqual(Array.from(events().at(-1).speakers,s=>s.handle),['ana','bruno']);
  for(let i=0;i<35;i++){f.process(0,.1);f.process(1,.1);}
  assert.equal(f.sent.filter(x=>x.payload?.type==='segment').length,2);assert.equal(events().filter(e=>e.speakers.length===0).length,1);
  f.advance(1600);f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(events().at(-1).speakers.length,0);
  f.process(0,.1);assert.equal(events().at(-1).speakers[0].handle,'ana');
  f.control({enabled:false});assert.equal(events().at(-1).speakers.length,0);
});
test('an identity learned after speech starts updates the active set without guessing',async()=>{
  const f=fixture();f.add('space-a',[{feed:'100'}]);f.control({enabled:true,epoch:'one',room:'space-a'});f.process(0,.1);
  const last=()=>f.sent.filter(x=>x.payload?.type==='activity').at(-1).payload;
  assert.equal(last().speakers[0].handle,'');
  await f.setResponse({twitter_user_id:'123',guest_participant_id:'100',guest_username:'ana'});
  f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(last().speakers[0].handle,'ana');f.control({enabled:false});
});
test('activity continues while transcription is unavailable and segments resume when Whisper recovers',()=>{
  const f=fixture();f.add('space-a',[{feed:'100',handle:'ana'}]);f.control({enabled:true,transcribe:false,epoch:'one',room:'space-a'});
  for(let i=0;i<3;i++)f.process(0,.1);for(let i=0;i<3;i++)f.process(0,0);
  assert.ok(f.sent.some(e=>e.payload?.type==='activity'&&e.payload.speakers.some(s=>s.handle==='ana')));assert.equal(f.sent.filter(e=>e.payload?.type==='segment').length,0);
  f.control({enabled:true,transcribe:true,epoch:'one',room:'space-a'});for(let i=0;i<3;i++)f.process(0,.1);for(let i=0;i<3;i++)f.process(0,0);
  assert.equal(f.sent.filter(e=>e.payload?.type==='segment').length,1);f.control({enabled:false});
});
test('passes the visible participant name with the account for both voice activity and final text',async()=>{
  const f=fixture();await f.setResponse({participants:{admins:[{periscope_user_id:'host-id',twitter_screen_name:'host_account',display_name:'Host Example'}]}});
  await f.setResponse({plugindata:{data:{room:'space-a',publishers:[{id:'100',display:'host-id'}]}}});
  f.add('space-a',[{feed:'100'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  for(let i=0;i<3;i++)f.process(0,.1);for(let i=0;i<3;i++)f.process(0,0);
  const speech=f.sent.find(e=>e.payload?.type==='activity'&&e.payload.speakers.length).payload.speakers[0];
  const segment=f.sent.find(e=>e.payload?.type==='segment').payload;
  assert.equal(speech.handle,'host_account');assert.equal(speech.displayName,'Host Example');assert.equal(segment.displayName,'Host Example');f.control({enabled:false});
});
test('links guest feed to profile name by account, keeps duplicate names distinct, and never treats Janus display as a name',async()=>{
  const f=fixture();await f.setResponse({users:[{rest_id:'1',core:{screen_name:'ana',name:'Ana Silva'}},{rest_id:'2',legacy:{screen_name:'bruno',name:'Ana Silva'}}]});
  await f.setResponse({guests:[{twitter_user_id:'1',guest_participant_id:'100',guest_username:'ana'},{twitter_user_id:'2',guest_participant_id:'200',guest_username:'bruno'}]});
  await f.setResponse({plugindata:{data:{room:'space-a',publishers:[{id:'300',display:'not-a-person-name'}]}}});
  f.add('space-a',[{feed:'100'},{feed:'200'},{feed:'300'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)f.process(j,.1);
  const people=f.sent.filter(e=>e.payload?.type==='activity').at(-1).payload.speakers;
  assert.deepEqual(Array.from(people,p=>[p.handle,p.displayName]),[['ana','Ana Silva'],['bruno','Ana Silva'],['','']]);f.control({enabled:false});
});
test('new visible name updates a speaking account without waiting for another turn',async()=>{
  const f=fixture();await f.setResponse({twitter_user_id:'1',guest_participant_id:'100',guest_username:'ana',guest_display_name:'Ana'});
  f.add('space-a',[{feed:'100'}]);f.control({enabled:true,epoch:'one',room:'space-a'});f.process(0,.1);
  await f.setResponse({rest_id:'1',core:{screen_name:'ana',name:'Ana Silva'}});f.control({enabled:true,epoch:'one',room:'space-a'});
  assert.equal(f.sent.filter(e=>e.payload?.type==='activity').at(-1).payload.speakers[0].displayName,'Ana Silva');f.control({enabled:false});
});
test('a self track identified after capture started is never emitted as a human transcript',async()=>{
  const f=fixture();f.add('space-a',[{feed:'100'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  for(let i=0;i<3;i++)f.process(0,.1);
  await f.setResponse({twitter_user_id:'1',guest_participant_id:'100',guest_username:'DemoAccount',guest_display_name:'DemoAccount'});
  for(let i=0;i<3;i++)f.process(0,0);
  assert.equal(f.sent.filter(e=>e.payload?.type==='segment').length,0);
  f.control({enabled:true,epoch:'one',room:'space-a'});assert.equal(f.clones[0].stopped,true);f.control({enabled:false});
});
test('another account whose visible name is DemoAccount remains a valid participant',async()=>{
  const f=fixture();await f.setResponse({twitter_user_id:'1',guest_participant_id:'100',guest_username:'ana',guest_display_name:'DemoAccount'});
  f.add('space-a',[{feed:'100'}]);f.control({enabled:true,epoch:'one',room:'space-a'});
  for(let i=0;i<3;i++)f.process(0,.1);for(let i=0;i<3;i++)f.process(0,0);
  const segment=f.sent.find(e=>e.payload?.type==='segment').payload;assert.equal(segment.handle,'ana');assert.equal(segment.displayName,'DemoAccount');f.control({enabled:false});
});
