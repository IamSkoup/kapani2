import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginHandler} from '../supabase/functions/kapani-login/handler.mjs';
const request=data=>new Request('https://kapani.test/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const response=data=>new Response(JSON.stringify(data),{status:200});
test('login does not expose resolved email or secret and returns only session tokens',async()=>{
 const calls=[];
 const handler=createLoginHandler({url:'https://backend.test',secret:'sb_secret_TEST_ONLY',publishable:'sb_publishable_TEST_ONLY',sleep:async()=>{},fetcher:async(url,init)=>{calls.push({url,init});return url.includes('prepare_login')?response({limited:false,email:'person@example.invalid'}):response({access_token:'access',refresh_token:'refresh',user:{email:'person@example.invalid'}});}});
 const result=await handler(request({identifier:'Nickname',password:'test-secret-password'}));
 assert.equal(result.status,200);assert.deepEqual(await result.json(),{access_token:'access',refresh_token:'refresh'});
 const gate=JSON.parse(calls[0].init.body);assert.match(gate.p_account_hash,/^[a-f0-9]{64}$/);assert.equal(gate.password,undefined);assert.equal(calls[0].init.headers.Authorization,undefined);
 assert.equal(JSON.parse(calls[1].init.body).email,'person@example.invalid');assert.equal(calls[1].init.headers.apikey,'sb_publishable_TEST_ONLY');
});
test('unknown username, limited request and wrong password share an error response',async()=>{
 const outcomes=[];
 for(const mode of ['unknown','limited','wrong']){
  const handler=createLoginHandler({url:'https://backend.test',secret:'sb_secret_TEST_ONLY',publishable:'public',sleep:async()=>{},fetcher:async url=>url.includes('prepare_login')?response({limited:mode==='limited',email:mode==='unknown'?null:'person@example.invalid'}):new Response('{}',{status:400})});
  const r=await handler(request({identifier:'someone',password:'incorrect'}));outcomes.push([r.status,await r.json()]);
 }
 assert.deepEqual(outcomes[0],outcomes[1]);assert.deepEqual(outcomes[1],outcomes[2]);assert.equal(outcomes[0][0],401);
});
test('oversized body is rejected before accessing backend',async()=>{
 const handler=createLoginHandler({url:'https://backend.test',secret:'secret',publishable:'public',fetcher:()=>assert.fail('must not call backend')});
 const r=await handler(request({identifier:'x',password:'x'.repeat(9000)}));assert.equal(r.status,413);
});
