const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','Content-Type':'application/json'};
export function createLoginHandler({url,secret,publishable,fetcher=fetch,clock=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:cors});
 const hash=async value=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');};
 return async req=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(req.method!=='POST')return response(405,{error:'Метод не поддерживается'});
  const start=clock();
  const denied=async()=>{await sleep(Math.max(0,800-(clock()-start)));return response(401,{error:'Не удалось войти. Проверь данные или повтори позже.'});};
  try{
   if(!url||!secret||!publishable)return response(503,{error:'Вход временно недоступен'});
   if(Number(req.headers.get('content-length'))>8192)return response(413,{error:'Слишком большой запрос'});
   const reader=req.body?.getReader();if(!reader)return denied();let size=0,parts=[];
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();return response(413,{error:'Слишком большой запрос'});}parts.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
   let data;try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{return denied();}
   const identifier=typeof data.identifier==='string'?data.identifier.trim().toLowerCase():'';
   if(!identifier||identifier.length>254||typeof data.password!=='string'||data.password.length>1024||!data.password)return denied();
   // Network headers are supplementary. Identifier counters remain enforced even if a proxy changes IP headers.
   const network=(req.headers.get('x-forwarded-for')??req.headers.get('cf-connecting-ip')??'unknown').split(',')[0].trim().slice(0,100);
   const headers={apikey:secret,'Content-Type':'application/json'};
   if(!secret.startsWith('sb_secret_'))headers.Authorization='Bearer '+secret;
   const gate=await fetcher(url+'/rest/v1/rpc/prepare_login',{method:'POST',headers,body:JSON.stringify({p_identifier:identifier,p_account_hash:await hash(identifier),p_network_hash:await hash(network)}),signal:AbortSignal.timeout(8000)});
   if(!gate.ok)return response(503,{error:'Вход временно недоступен'});
   const info=await gate.json();if(info.limited||!info.email)return denied();
   const signed=await fetcher(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:publishable,'Content-Type':'application/json'},body:JSON.stringify({email:info.email,password:data.password,gotrue_meta_security:{captcha_token:typeof data.captchaToken==='string'?data.captchaToken:undefined}}),signal:AbortSignal.timeout(8000)});
   if(!signed.ok)return denied();const session=await signed.json();
   if(!session.access_token||!session.refresh_token)return response(503,{error:'Вход временно недоступен'});
   return response(200,{access_token:session.access_token,refresh_token:session.refresh_token});
  }catch{return response(503,{error:'Вход временно недоступен'});}
 };
}
