// Preserve Supabase confirmation/recovery parameters on branch-based Pages.
location.replace(new URL('./public/' + location.search + location.hash, location.href).href);
