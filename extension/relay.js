(() => {
  const local=['127.0.0.1','localhost'].includes(location.hostname)&&location.protocol==='http:';
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    const m=event.data;
    if(local&&m?.channel==='x-spaces-audio-pair'){
      chrome.runtime.sendMessage({type:'pair',endpoint:location.origin,token:m.token},response=>window.postMessage({channel:'x-spaces-audio-paired',ok:response?.paired===true},location.origin));
    }else if(!local&&m?.channel==='x-spaces-audio-event'&&JSON.stringify(m.payload||{}).length<570000){
      chrome.runtime.sendMessage({type:'event',payload:m.payload},()=>void chrome.runtime.lastError);
    }
  });
  if(!local){
    const source='relay-'+crypto.randomUUID();
    const poll=()=>chrome.runtime.sendMessage({type:'control'},response=>{void chrome.runtime.lastError;window.postMessage({channel:'x-spaces-audio-control',control:response||{enabled:false}},location.origin);if(response?.enabled)chrome.runtime.sendMessage({type:'event',payload:{type:'connector',source,room:response.room,epoch:response.epoch}},()=>void chrome.runtime.lastError);});
    poll();setInterval(poll,2000);
  }
})();
