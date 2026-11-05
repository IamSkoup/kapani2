import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePoints,validateRoute,createRouteHandler} from '../supabase/functions/kapani-route/handler.mjs';
const route=()=>({code:'Ok',routes:[{distance:1234.2,duration:179.5,geometry:{type:'LineString',coordinates:[[38.5,52.6],[38.51,52.61]]}}],waypoints:[{distance:10},{distance:20}]});
test('coordinates reject strings, non-finite and out-of-range inputs',()=>{
 const p={pickup_lat:52.6,pickup_lng:38.5,dropoff_lat:52.61,dropoff_lng:38.51};assert.deepEqual(validatePoints(p),p);
 for(const v of [NaN,Infinity,91,'52.6',null])assert.throws(()=>validatePoints({...p,pickup_lat:v}));
});
test('route uses provider road distance and duration, rounded upward',()=>{
 assert.equal(validateRoute(route()).distance,1235);assert.equal(validateRoute(route()).duration,180);
});
test('no route, malformed geometry and distant snapping cannot produce a quote',()=>{
 assert.throws(()=>validateRoute({code:'NoRoute'}));
 const a=route();a.routes[0].geometry.coordinates[1]=[null,52.6];assert.throws(()=>validateRoute(a));
 const b=route();b.waypoints[0].distance=501;assert.throws(()=>validateRoute(b));
});
test('missing router fails closed without creating price or contacting backend',async()=>{
 const handler=createRouteHandler({router:'',fetcher:()=>assert.fail('unexpected request')});
 const response=await handler(new Request('https://kapani.test/route',{method:'POST'}));assert.equal(response.status,503);assert.match((await response.json()).error,/не подключён/);
});
test('unavailable routing provider never falls back to direct distance or stores a quote',async()=>{
 const calls=[];const handler=createRouteHandler({url:'https://backend.test',secret:'sb_secret_TEST',publishable:'public',router:'https://router.test',fetcher:async(url,init)=>{calls.push(String(url));if(String(url).includes('/auth/'))return Response.json({id:'user'});if(String(url).includes('reserve_taxi_route'))return Response.json(true);return new Response('Unavailable',{status:503});}});
 const response=await handler(new Request('https://kapani.test/route',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({pickup_lat:52.6,pickup_lng:38.5,dropoff_lat:52.61,dropoff_lng:38.51})}));
 assert.equal(response.status,503);assert.equal(calls.length,3);assert.ok(!calls.some(x=>x.includes('store_taxi_quote')));
});
