const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store'};
export function validatePoints(data){
 const keys=['pickup_lat','pickup_lng','dropoff_lat','dropoff_lng'];
 if(!data||!keys.every(k=>typeof data[k]==='number'&&Number.isFinite(data[k])&&Math.abs(data[k])<=(k.endsWith('lat')?85:180)))throw Error('Укажи корректные координаты отправления и назначения');
 return Object.fromEntries(keys.map(k=>[k,data[k]]));
}
export function validateRoute(data){
 const r=data?.routes?.[0];
 if(data?.code!=='Ok'||!r||!Number.isFinite(r.distance)||!Number.isFinite(r.duration)||r.distance<10||r.distance>250000||r.duration<=0||r.duration>21600||r.geometry?.type!=='LineString'||!Array.isArray(r.geometry.coordinates)||r.geometry.coordinates.length<2||r.geometry.coordinates.length>20000)throw Error('Дорожный маршрут не найден');
 if(!r.geometry.coordinates.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=85))throw Error('Некорректная геометрия маршрута');
 if(!Array.isArray(data.waypoints)||data.waypoints.length!==2||data.waypoints.some(w=>!Number.isFinite(w.distance)||w.distance>500))throw Error('Точка слишком далеко от доступной дороги');
 return {distance:Math.ceil(r.distance),duration:Math.ceil(r.duration),geometry:r.geometry};
}
export function createRouteHandler({url,secret,publishable,router,fetcher=fetch}){
 const reply=(status,data)=>new Response(JSON.stringify(data),{status,headers});
 return async req=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return reply(405,{error:'Метод не поддерживается'});
  if(!router)return reply(503,{error:'Дорожный маршрутизатор ещё не подключён. Стоимость не рассчитана.'});
  try{
   const authorization=req.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return reply(401,{error:'Войди в аккаунт'});
   if(Number(req.headers.get('content-length'))>2048)return reply(413,{error:'Слишком большой запрос'});
   const text=await req.text();if(text.length>2048)return reply(413,{error:'Слишком большой запрос'});
   let points;try{points=validatePoints(JSON.parse(text));}catch(e){return reply(400,{error:e.message});}
   const auth=await fetcher(url+'/auth/v1/user',{headers:{apikey:publishable,Authorization:authorization},signal:AbortSignal.timeout(8000)});
   if(!auth.ok)return reply(401,{error:'Сеанс недействителен'});const user=await auth.json();if(!user.id)return reply(401,{error:'Сеанс недействителен'});
   const serviceHeaders={apikey:secret,'Content-Type':'application/json'};if(!secret.startsWith('sb_secret_'))serviceHeaders.Authorization='Bearer '+secret;
   const gate=await fetcher(url+'/rest/v1/rpc/reserve_taxi_route',{method:'POST',headers:serviceHeaders,body:JSON.stringify({p_user:user.id}),signal:AbortSignal.timeout(8000)});
   if(!gate.ok)return reply(503,{error:'Не удалось проверить доступ'});if(!(await gate.json()))return reply(403,{error:'Нужно подтверждение мэрии; также действует лимит 30 расчётов в час.'});
   const base=new URL(router);if(base.protocol!=='https:')return reply(503,{error:'Ошибка настройки маршрутизатора'});
   const {pickup_lat:a,pickup_lng:b,dropoff_lat:c,dropoff_lng:d}=points;
   base.pathname=base.pathname.replace(/\/$/,'')+`/route/v1/driving/${b},${a};${d},${c}`;base.searchParams.set('overview','full');base.searchParams.set('geometries','geojson');base.searchParams.set('steps','false');
   const routed=await fetcher(base,{signal:AbortSignal.timeout(8000)});if(!routed.ok)return reply(503,{error:'Дорожный маршрутизатор недоступен. Заказ не создан.'});
   let route;try{route=validateRoute(await routed.json());}catch(e){return reply(422,{error:e.message});}
   const quote=await fetcher(url+'/rest/v1/rpc/store_taxi_quote',{method:'POST',headers:serviceHeaders,body:JSON.stringify({p_user:user.id,...Object.fromEntries(Object.entries(points).map(([k,v])=>['p_'+k,v])),p_distance:route.distance,p_duration:route.duration,p_provider:base.hostname,p_geometry:route.geometry}),signal:AbortSignal.timeout(8000)});
   if(!quote.ok)return reply(400,{error:'Не удалось сохранить расчёт. Обнови страницу и повтори.'});return reply(200,await quote.json());
  }catch{return reply(503,{error:'Расчёт маршрута временно недоступен. Оплата не списана.'});}
 };
}
