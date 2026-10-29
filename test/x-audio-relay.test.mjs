import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(){let handler,storage={},requests=[];const ctx=vm.createContext({chrome:{runtime:{onMessage:{addListener:fn=>{handler=fn;}}},storage:{local:{get:async()=>storage,set:async data=>{storage={...storage,...data};}}}},URL,AbortSignal,fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({enabled:true})};}});vm.runInContext(readFileSync(new URL('../extension/background.js',import.meta.url),'utf8'),ctx);return {requests,send:(message,url)=>new Promise(resolve=>handler(message,{url},resolve))};}
test('pairing is accepted only from its local origin, and X cannot select a destination or obtain the bearer',async()=>{
 const f=fixture(),token='a'.repeat(64);assert.equal((await f.send({type:'pair',endpoint:'http://127.0.0.1:4173',token},'https://x.com/home')).enabled,false);assert.equal(f.requests.length,0);
 assert.equal((await f.send({type:'pair',endpoint:'https://evil.test',token},'https://evil.test')).enabled,false);
 assert.equal((await f.send({type:'pair',endpoint:'http://127.0.0.1:4173',token},'http://127.0.0.1:4173/')).paired,true);
 const control=await f.send({type:'control',endpoint:'https://evil.test'},'https://x.com/home');assert.equal(control.enabled,true);assert.equal(JSON.stringify(control).includes(token),false);assert.equal(f.requests[0].url,'http://127.0.0.1:4173/api/x-audio/control');assert.equal(f.requests[0].options.headers.Authorization,'Bearer '+token);
 await f.send({type:'event',payload:{type:'status',tracks:2}},'https://evil.test');assert.equal(f.requests.length,1);
});
