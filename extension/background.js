const localOrigin = value => { try { const u=new URL(value);return u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)&&!u.username&&!u.password?u.origin:null; } catch {return null;} };
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  void (async()=>{
    const origin=new URL(sender.url||'https://invalid.test').origin;
    if(message.type==='pair'){
      const endpoint=localOrigin(message.endpoint);
      if(!endpoint||endpoint!==origin||!/^[a-f0-9]{64}$/.test(message.token||''))throw new Error('Ligação local inválida.');
      await chrome.storage.local.set({xSpacesAudio:{endpoint,token:message.token}});return {paired:true};
    }
    if(!['https://x.com','https://twitter.com'].includes(origin))throw new Error('Origem inválida.');
    const {xSpacesAudio:config}=await chrome.storage.local.get('xSpacesAudio');
    if(!config||!localOrigin(config.endpoint))return {enabled:false,reason:'unpaired'};
    const headers={Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'};
    if(message.type==='control'){
      const response=await fetch(config.endpoint+'/api/x-audio/control',{headers,signal:AbortSignal.timeout(5000)});
      if(!response.ok)return {enabled:false,reason:response.status===401?'pair_again':'server_error'};
      return await response.json();
    }
    if(message.type==='event'){
      const response=await fetch(config.endpoint+'/api/x-audio/event',{method:'POST',headers,body:JSON.stringify(message.payload),signal:AbortSignal.timeout(95000)});
      return response.ok?await response.json():{error:'O conector recusou o evento de áudio.'};
    }
    return {enabled:false};
  })().then(reply).catch(()=>reply({enabled:false,error:'Conector local indisponível.'}));
  return true;
});
