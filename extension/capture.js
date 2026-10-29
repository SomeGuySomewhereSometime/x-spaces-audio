/* Runs in the X page. Never exports cookies, tokens, SDP or raw signalling. */
(() => {
  if(window.__xSpacesAudio)return;
  const peers=new Map(),offers=new Map(),identities=new Map(),names=new Map(),publishers=new Map(),nodes=new Map();
  let control={enabled:false},context=null,serial=0,activitySequence=0,activityKey='',rootRoom='',ownHandle='',lastError='';
  const counters={responses:0,janusEvents:0};
  const sdpKey=s=>typeof s==='string'?s.replace(/\r\n?/g,'\n').trim():'';
  const source=crypto.randomUUID();
  const emit=payload=>window.postMessage({channel:'x-spaces-audio-event',payload:{...payload,room:control.room,epoch:control.epoch,source}},location.origin);
  const validHandle=s=>typeof s==='string'&&/^[A-Za-z0-9_]{1,15}$/.test(s);
  const cleanName=s=>typeof s==='string'?s.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,80):'';
  function rememberName(handle,...values){
    if(!validHandle(handle))return;
    const name=values.map(cleanName).find(Boolean);
    if(name)names.set(handle.toLowerCase(),name);
    if(names.size>1000)names.clear();
  }
  function inspectUsers(value,depth=0){
    if(!value||typeof value!=='object'||depth>16)return;
    if(value.twitter_user_id&&validHandle(value.guest_username)){
      identities.set('feed:'+value.guest_participant_id,value.guest_username);
      rememberName(value.guest_username,value.guest_display_name,value.guestDisplayName,value.display_name);
    }
    const handle=value.screen_name||value.legacy?.screen_name||value.core?.screen_name;
    const id=value.rest_id||value.id_str;
    if(validHandle(handle)&&id){identities.set('twitter:'+id,handle);rememberName(handle,value.core?.name,value.legacy?.name,value.name,value.display_name);}
    if(validHandle(value.twitter_screen_name)&&value.id)identities.set('display:'+value.id,value.twitter_screen_name);
    if(validHandle(value.twitter_screen_name)&&value.periscope_user_id)identities.set('display:'+value.periscope_user_id,value.twitter_screen_name);
    if(validHandle(value.twitter_screen_name))rememberName(value.twitter_screen_name,value.display_name,value.twitter_name,value.name);
    for(const v of Object.values(value))if(v&&typeof v==='object')Array.isArray(v)?v.slice(0,200).forEach(x=>inspectUsers(x,depth+1)):inspectUsers(v,depth+1);
    if(identities.size>1000)identities.clear();
  }
  function observe(data){
    if(!data||typeof data!=='object')return;
    if(Array.isArray(data)){data.forEach(observe);return;}
    inspectUsers(data);
    const plugin=data.plugindata?.data;
    if(plugin){
      counters.janusEvents++;
      if(plugin.room)rootRoom=String(plugin.room);
      for(const p of plugin.publishers||[]){publishers.set(String(p.id),p);const name=identities.get('display:'+p.periscope_user_id)||identities.get('display:'+p.display)||identities.get('twitter:'+p.display);if(name)identities.set('feed:'+p.id,name);}
      if(publishers.size>200)publishers.clear();
      if(data.jsep?.sdp&&plugin.streams){
        const meta={room:String(plugin.room||rootRoom),streams:plugin.streams,handle:data.sender};offers.set(sdpKey(data.jsep.sdp),meta);
        for(const [pc]of peers)if(sdpKey(pc.remoteDescription?.sdp)===sdpKey(data.jsep.sdp))peers.set(pc,meta);
        if(offers.size>24)offers.delete(offers.keys().next().value);
      }
      if(plugin.videoroom==='updated'&&plugin.streams)for(const [pc,meta]of peers)if(meta.handle===data.sender){meta.streams=plugin.streams;}
    }
  }
  const originalFetch=window.fetch;
  window.fetch=async function(...args){
    const response=await originalFetch.apply(this,args);
    try{const url=new URL(response.url);if(/(^|\.)pscp\.tv$/.test(url.hostname)||url.hostname==='x.com'&&url.pathname.includes('/graphql/')){counters.responses++;void response.clone().json().then(observe).catch(()=>{});}}catch{}
    return response;
  };
  const originalOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(...args){
    this.addEventListener('load',()=>{try{const url=new URL(this.responseURL);if(/(^|\.)pscp\.tv$/.test(url.hostname)||url.hostname==='x.com'&&url.pathname.includes('/graphql/')){counters.responses++;observe(this.responseType==='json'?this.response:JSON.parse(this.responseText));}}catch{}},{once:true});
    return originalOpen.apply(this,args);
  };
  const originalSet=RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription=async function(description){
    const result=await originalSet.call(this,description);if(!peers.has(this))peers.set(this,{room:'',streams:[]});
    const offer=offers.get(sdpKey(description?.sdp));if(offer)peers.set(this,offer);return result;
  };
  const NativePeer=window.RTCPeerConnection||RTCPeerConnection;
  window.RTCPeerConnection=new Proxy(NativePeer,{construct(target,args,newTarget){const pc=Reflect.construct(target,args,newTarget);peers.set(pc,{room:'',streams:[]});return pc;}});
  function drop(key,announce=true){const n=nodes.get(key);if(!n)return;n.processor.onaudioprocess=null;n.source.disconnect();n.processor.disconnect();n.gain.disconnect();n.clone.stop();nodes.delete(key);if(announce)publishActivity();}
  function stop(){for(const key of [...nodes.keys()])drop(key,false);publishActivity();activityKey='';context?.close().catch(()=>{});context=null;}
  function handleFor(feed,stream={}){const p=publishers.get(feed)||{};return identities.get('feed:'+feed)||identities.get('display:'+p.periscope_user_id)||identities.get('display:'+p.display)||identities.get('display:'+stream.feed_display)||identities.get('twitter:'+stream.feed_display)||'';}
  function publishActivity(heartbeat=false){
    if(!control.enabled)return;
    const atMs=Date.now(),byFeed=new Map();
    for(const n of nodes.values()){
      if(!n.active)continue;
      // A suspended context must not keep a participant speaking indefinitely.
      if(context?.state!=='running'||atMs-n.lastVoicedAtMs>1200){n.active=false;n.activitySamples=0;continue;}
      const handle=handleFor(n.feed,n.stream)||n.handle;
      if(handle&&handle.toLowerCase()===ownHandle.toLowerCase())continue;
      const previous=byFeed.get(n.feed);
      if(!previous||previous.lastVoicedAtMs<n.lastVoicedAtMs)byFeed.set(n.feed,{feed:n.feed,handle,displayName:names.get(handle.toLowerCase())||'',startedAtMs:n.activityStartedAtMs,lastVoicedAtMs:n.lastVoicedAtMs});
    }
    const speakers=[...byFeed.values()].sort((a,b)=>a.feed.localeCompare(b.feed));
    const key=JSON.stringify(speakers.map(s=>[s.feed,s.handle,s.displayName,s.startedAtMs]));
    if(key===activityKey&&(!heartbeat||!speakers.length))return;
    activityKey=key;
    emit({type:'activity',sequence:++activitySequence,atMs,speakers});
  }
  function encode(blocks){let length=blocks.reduce((n,b)=>n+b.length,0),bytes=new Uint8Array(length*2),view=new DataView(bytes.buffer),i=0;for(const block of blocks)for(const x of block)view.setInt16(2*i++,Math.round(Math.max(-1,Math.min(1,x))*32767),true);let binary='';for(let p=0;p<bytes.length;p+=8192)binary+=String.fromCharCode(...bytes.subarray(p,p+8192));return btoa(binary);}
  function attach(pc,meta,transceiver){
    const mid=transceiver.mid,stream=meta.streams.find(s=>String(s.mid)===String(mid)&&s.type==='audio'&&s.active!==false);
    if(!stream)return;
    const feed=String(stream.feed_id??stream.feed??'');if(!feed)return;
    const track=transceiver.receiver.track,key=track.id+':'+feed;
    const handle=handleFor(feed,stream);
    // Identity can arrive after this receiver was already attached.
    if(handle&&handle.toLowerCase()===ownHandle.toLowerCase()){drop(key);return;}
    if(nodes.has(key))return;
    context??=new AudioContext();if(context.state==='suspended')void context.resume();
    const clone=track.clone(),input=context.createMediaStreamSource(new MediaStream([clone])),processor=context.createScriptProcessor(4096,1,1),gain=context.createGain();gain.gain.value=0;
    const n={clone,source:input,processor,gain,feed,handle,stream,blocks:[],preroll:[],samples:0,quiet:0,start:0,voiced:0,active:false,activitySamples:0,activityQuiet:0,activityStartedAtMs:0,lastVoicedAtMs:0};nodes.set(key,n);
    input.connect(processor);processor.connect(gain);gain.connect(context.destination);
    const flush=()=>{
      const handle=handleFor(feed,stream)||n.handle;
      if(n.voiced>=3200&&n.samples<=192000&&control.enabled&&control.transcribe!==false&&(!handle||handle.toLowerCase()!==ownHandle.toLowerCase())){emit({type:'segment',id:source+':'+(++serial),feed,handle,displayName:names.get(handle.toLowerCase())||'',startedAtMs:n.start,endedAtMs:n.start+n.samples/16,pcm:encode(n.blocks)});}
      n.blocks=[];n.samples=0;n.quiet=0;n.voiced=0;n.start=0;
    };
    processor.onaudioprocess=event=>{
      if(!control.enabled||meta.room!==control.room)return;
      const identity=handleFor(feed,stream)||n.handle;
      if(identity&&identity.toLowerCase()===ownHandle.toLowerCase()){drop(key);return;}
      const raw=event.inputBuffer.getChannelData(0),ratio=event.inputBuffer.sampleRate/16000;
      const block=new Float32Array(Math.floor(raw.length/ratio));let energy=0;
      for(let i=0;i<block.length;i++){let p=i*ratio,j=Math.floor(p);block[i]=raw[j]+((raw[j+1]??raw[j])-raw[j])*(p-j);energy+=block[i]*block[i];}
      const voiced=Math.sqrt(energy/block.length)>0.008;
      if(voiced){
        if(!n.activitySamples)n.activityStartedAtMs=Date.now()-block.length/16;
        n.activitySamples+=block.length;n.activityQuiet=0;n.lastVoicedAtMs=Date.now();
        if(!n.active&&n.activitySamples>=2560){n.active=true;publishActivity();}
      }else{
        n.activityQuiet+=block.length;
        if(n.activityQuiet>=9600){const wasActive=n.active;n.active=false;n.activitySamples=0;if(wasActive)publishActivity();}
        else if(!n.active)n.activitySamples=0;
      }
      if(!n.start){if(!voiced){n.preroll.push(block);if(n.preroll.length>3)n.preroll.shift();return;}n.blocks=n.preroll;n.preroll=[];n.samples=n.blocks.reduce((s,b)=>s+b.length,0);n.start=Date.now()-(n.samples+block.length)/16;}
      n.blocks.push(block);n.samples+=block.length;if(voiced){n.quiet=0;n.voiced+=block.length;}else n.quiet+=block.length;
      if(n.quiet>=9600||n.samples>=128000)flush();
    };
    clone.addEventListener('ended',()=>drop(key),{once:true});
  }
  function reconcile(){
    if(!control.enabled)return;
    const profile=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');ownHandle=profile?.getAttribute('href')?.slice(1)||ownHandle;
    const live=new Set();
    let matchingPeers=0,receivers=0;
    for(let [pc,meta]of peers){
      if(pc.connectionState==='closed'){peers.delete(pc);continue;}
      const known=offers.get(sdpKey(pc.remoteDescription?.sdp));if(known&&known!==meta){meta=known;peers.set(pc,known);}
      if(meta.room!==control.room)continue;
      matchingPeers++;
      for(const t of pc.getTransceivers()){if(t.receiver.track.kind!=='audio'||t.receiver.track.readyState==='ended'||!['recvonly','sendrecv'].includes(t.currentDirection))continue;receivers++;const s=meta.streams.find(s=>String(s.mid)===String(t.mid)&&s.type==='audio'&&s.active!==false);if(!s)continue;live.add(t.receiver.track.id+':'+String(s.feed_id??s.feed??''));try{attach(pc,meta,t);}catch{lastError='capture_failed';}}
    }
    for(const key of nodes.keys())if(!live.has(key))drop(key,false);
    emit({type:'status',tracks:nodes.size,diagnostics:{version:3,...counters,peers:peers.size,offers:offers.size,matchingPeers,receivers,context:context?.state||'none',error:lastError}});
    publishActivity(true);
  }
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='x-spaces-audio-control')return;
    const next=event.data.control||{enabled:false};
    if(next.enabled!==true||next.epoch!==control.epoch||next.room!==control.room)stop();
    control=next;try{reconcile();}catch{emit({type:'status',tracks:0,diagnostics:{version:3,error:'bridge_failed',...counters,peers:peers.size,offers:offers.size}});}
  });
  // Also permits attaching already-open peers during a developer verification.
  window.__xSpacesAudio={attachExisting(pc,meta,people=[]){people.forEach(p=>{if(validHandle(p.handle))identities.set('feed:'+p.feed,p.handle);});peers.set(pc,meta);reconcile();},stop};
})();
