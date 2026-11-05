begin;
create table public.map_places(id uuid primary key,title text not null check(length(title) between 2 and 160),description text not null check(length(description)<=4000),address text not null check(length(address)<=500),latitude numeric not null check(latitude between -85 and 85),longitude numeric not null check(longitude between -180 and 180),active boolean not null default true,created_by uuid not null references public.profiles,created_at timestamptz not null default now());
create index map_places_coordinates on public.map_places(latitude,longitude) where active;
alter table public.map_places enable row level security;
revoke all on public.map_places from public,anon,authenticated;
grant select on public.map_places to authenticated;
create policy map_places_read on public.map_places for select to authenticated using(kapani_private.active() and (active or kapani_private.mayor()));
create function public.save_map_place(p_id uuid,p_title text,p_description text,p_address text,p_latitude numeric,p_longitude numeric,p_active boolean) returns uuid language plpgsql security definer set search_path='' as $$begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 insert into public.map_places(id,title,description,address,latitude,longitude,active,created_by) values(p_id,p_title,p_description,p_address,p_latitude,p_longitude,p_active,auth.uid()) on conflict(id) do update set title=excluded.title,description=excluded.description,address=excluded.address,latitude=excluded.latitude,longitude=excluded.longitude,active=excluded.active;
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'map.place',p_id);return p_id;
end$$;
create function public.map_points(p_south numeric,p_west numeric,p_north numeric,p_east numeric,p_search text default '') returns table(id uuid,kind text,title text,address text,latitude numeric,longitude numeric,href text) language sql stable security definer set search_path='' as $$
 select x.* from (
 select p.id,'place'::text,p.title,p.address,p.latitude,p.longitude,'#map'::text from public.map_places p where p.active
 union all select b.id,'building',b.title,b.address,b.latitude,b.longitude,'#rentals' from public.buildings b where b.active
 union all select e.id,'event',e.title,e.address,e.latitude,e.longitude,'#events' from public.events e where e.status in('open','closed') and e.ends_at>now()
 union all select b.id,'business',b.name,r.address,r.latitude,r.longitude,'#shop' from public.businesses b join public.leases l on l.id=b.lease_id join public.buildings r on r.id=l.building_id where b.status='active' and l.status='active' and l.starts_on<=(now() at time zone 'Europe/Moscow')::date and l.ends_on>(now() at time zone 'Europe/Moscow')::date
 )x(id,kind,title,address,latitude,longitude,href)
 where kapani_private.active() and x.latitude between p_south and p_north and x.longitude between p_west and p_east and (coalesce(p_search,'')='' or x.title ilike '%'||left(p_search,100)||'%' or x.address ilike '%'||left(p_search,100)||'%') order by x.kind,x.title,x.id limit 200
$$;
revoke all on function public.save_map_place(uuid,text,text,text,numeric,numeric,boolean),public.map_points(numeric,numeric,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.save_map_place(uuid,text,text,text,numeric,numeric,boolean),public.map_points(numeric,numeric,numeric,numeric,text) to authenticated;
commit;
