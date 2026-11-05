import { createLoginHandler } from './handler.mjs';
const key = (name: string, legacy: string) => {
  try { const keys = JSON.parse(Deno.env.get(name) ?? '{}'); if (keys.default) return keys.default; } catch { /* No values are logged. */ }
  return Deno.env.get(legacy) ?? '';
};
Deno.serve(createLoginHandler({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  secret: key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'),
  publishable: key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'),
}));
