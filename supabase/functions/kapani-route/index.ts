import { createRouteHandler } from './handler.mjs';
const key=(name:string,legacy:string)=>{try{const k=JSON.parse(Deno.env.get(name)??'{}');if(k.default)return k.default;}catch{}return Deno.env.get(legacy)??'';};
Deno.serve(createRouteHandler({url:Deno.env.get('SUPABASE_URL')??'',secret:key('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY'),publishable:key('SUPABASE_PUBLISHABLE_KEYS','SUPABASE_ANON_KEY'),router:Deno.env.get('KAPANI_OSRM_BASE_URL')??''}));
