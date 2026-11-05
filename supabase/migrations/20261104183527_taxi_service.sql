begin;
create table public.taxi_rates(id uuid primary key default gen_random_uuid(),base_amount bigint not null check(base_amount between 1 and 1000000),per_km bigint not null check(per_km between 1 and 100000),per_minute bigint not null check(per_minute between 0 and 100000),commission_percent integer not null check(commission_percent between 0 and 50),created_at timestamptz not null default now());
insert into public.taxi_rates(base_amount,per_km,per_minute,commission_percent) values(5000,1500,100,10);
create table public.taxi_quotes(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles,rate_id uuid not null references public.taxi_rates,pickup_lat numeric not null check(pickup_lat between -85 and 85),pickup_lng numeric not null check(pickup_lng between -180 and 180),dropoff_lat numeric not null check(dropoff_lat between -85 and 85),dropoff_lng numeric not null check(dropoff_lng between -180 and 180),distance_m integer not null check(distance_m between 10 and 250000),duration_s integer not null check(duration_s between 1 and 21600),amount bigint not null check(amount>0),commission bigint not null check(commission>=0 and commission<amount),provider text not null,geometry jsonb not null,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '5 minutes');
create index taxi_quotes_user on public.taxi_quotes(user_id,created_at desc);
create table public.taxi_drivers(user_id uuid primary key references public.profiles,vehicle text not null check(length(vehicle) between 3 and 160),plate text not null check(length(plate) between 2 and 32),online boolean not null default false,available_since timestamptz not null default now(),share_location boolean not null default false,latitude numeric check(latitude between -85 and 85),longitude numeric check(longitude between -180 and 180),location_at timestamptz);
create table public.taxi_rides(id uuid primary key default gen_random_uuid(),quote_id uuid not null unique references public.taxi_quotes,passenger_id uuid not null references public.profiles,driver_id uuid references public.profiles,escrow_id uuid not null unique references public.accounts,status text not null check(status in('searching','offered','accepted','arriving','waiting','in_progress','completed','cancelled')),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create unique index taxi_driver_active on public.taxi_rides(driver_id) where status in('accepted','arriving','waiting','in_progress');
create unique index taxi_passenger_active on public.taxi_rides(passenger_id) where status not in('completed','cancelled');
create index taxi_rides_queue on public.taxi_rides(status,created_at);
create table public.taxi_offers(id uuid primary key default gen_random_uuid(),ride_id uuid not null references public.taxi_rides,driver_id uuid not null references public.profiles,status text not null default 'pending' check(status in('pending','accepted','declined','expired')),expires_at timestamptz not null default now()+interval '45 seconds',unique(ride_id,driver_id));
create unique index taxi_offer_driver_pending on public.taxi_offers(driver_id) where status='pending';
create unique index taxi_offer_ride_pending on public.taxi_offers(ride_id) where status='pending';
create table public.taxi_history(id bigint generated always as identity primary key,ride_id uuid not null references public.taxi_rides,actor uuid references public.profiles,status text not null,reason text not null default '',created_at timestamptz not null default now());
create index taxi_history_ride on public.taxi_history(ride_id,id);
create function kapani_private.taxi_access(p_ride uuid) returns boolean language sql stable security definer set search_path='' as $$select kapani_private.active() and exists(select 1 from public.taxi_rides r where r.id=p_ride and (r.passenger_id=auth.uid() or r.driver_id=auth.uid() or kapani_private.mayor() or exists(select 1 from public.taxi_offers o where o.ride_id=r.id and o.driver_id=auth.uid() and o.status='pending' and o.expires_at>now())))$$;
revoke all on function kapani_private.taxi_access(uuid) from public,anon;grant execute on function kapani_private.taxi_access(uuid) to authenticated;
do $$declare t text;begin foreach t in array array['taxi_rates','taxi_quotes','taxi_drivers','taxi_rides','taxi_offers','taxi_history'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);end loop;end$$;
create policy taxi_rates_read on public.taxi_rates for select to authenticated using(kapani_private.active());
create policy taxi_quotes_read on public.taxi_quotes for select to authenticated using(kapani_private.active() and (user_id=auth.uid() or exists(select 1 from public.taxi_rides r where r.quote_id=taxi_quotes.id and kapani_private.taxi_access(r.id))));
create policy taxi_drivers_own on public.taxi_drivers for select to authenticated using(kapani_private.active() and user_id=auth.uid());
create policy taxi_rides_read on public.taxi_rides for select to authenticated using(kapani_private.taxi_access(id));
create policy taxi_offers_read on public.taxi_offers for select to authenticated using(kapani_private.active() and driver_id=auth.uid());
create policy taxi_history_read on public.taxi_history for select to authenticated using(kapani_private.taxi_access(ride_id));
create trigger taxi_history_immutable before update or delete on public.taxi_history for each row execute function kapani_private.immutable();
create trigger taxi_quotes_immutable before update or delete on public.taxi_quotes for each row execute function kapani_private.immutable();
create trigger taxi_rates_immutable before update or delete on public.taxi_rates for each row execute function kapani_private.immutable();
create function public.store_taxi_quote(p_user uuid,p_pickup_lat numeric,p_pickup_lng numeric,p_dropoff_lat numeric,p_dropoff_lng numeric,p_distance integer,p_duration integer,p_provider text,p_geometry jsonb) returns public.taxi_quotes language plpgsql security definer set search_path='' as $$declare rate public.taxi_rates;q public.taxi_quotes;amount bigint;begin
 if not exists(select 1 from public.profiles where id=p_user and verified and not blocked) then raise exception 'Municipal verification required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,51));
 if (select count(*) from public.taxi_quotes where user_id=p_user and created_at>now()-interval '1 hour')>=30 then raise exception 'Rate limit';end if;
 if p_geometry->>'type'<>'LineString' or jsonb_typeof(p_geometry->'coordinates')<>'array' or jsonb_array_length(p_geometry->'coordinates') not between 2 and 20000 or length(p_geometry::text)>2000000 then raise exception 'Invalid route';end if;
 select * into rate from public.taxi_rates order by created_at desc,id desc limit 1;
 amount:=rate.base_amount+ceil(p_distance::numeric*rate.per_km/1000)::bigint+ceil(p_duration::numeric*rate.per_minute/60)::bigint;
 insert into public.taxi_quotes(user_id,rate_id,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,distance_m,duration_s,amount,commission,provider,geometry) values(p_user,rate.id,p_pickup_lat,p_pickup_lng,p_dropoff_lat,p_dropoff_lng,p_distance,p_duration,amount,floor(amount*rate.commission_percent::numeric/100)::bigint,p_provider,p_geometry) returning * into q;return q;
end$$;
revoke all on function public.store_taxi_quote(uuid,numeric,numeric,numeric,numeric,integer,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_taxi_quote(uuid,numeric,numeric,numeric,numeric,integer,integer,text,jsonb) to service_role;
create function public.set_taxi_driver(p_vehicle text,p_plate text,p_online boolean,p_share boolean) returns void language plpgsql security definer set search_path='' as $$begin
 if not kapani_private.has_role('driver') or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Access denied';end if;
 insert into public.taxi_drivers(user_id,vehicle,plate,online,share_location) values(auth.uid(),p_vehicle,p_plate,p_online,p_share) on conflict(user_id) do update set vehicle=excluded.vehicle,plate=excluded.plate,online=excluded.online,share_location=excluded.share_location,latitude=case when excluded.share_location then taxi_drivers.latitude else null end,longitude=case when excluded.share_location then taxi_drivers.longitude else null end,location_at=case when excluded.share_location then taxi_drivers.location_at else null end;
end$$;
create function kapani_private.dispatch_taxi(p_ride uuid) returns void language plpgsql security definer set search_path='' as $$declare r public.taxi_rides;d uuid;begin
 select * into r from public.taxi_rides where id=p_ride and status='searching' for update;if not found then return;end if;
 select t.user_id into d from public.taxi_drivers t join public.profiles p on p.id=t.user_id where t.online and p.verified and not p.blocked and t.user_id<>r.passenger_id and exists(select 1 from public.user_roles where user_id=t.user_id and role='driver') and not exists(select 1 from public.taxi_offers where driver_id=t.user_id and status='pending') and not exists(select 1 from public.taxi_rides where driver_id=t.user_id and status in('accepted','arriving','waiting','in_progress')) and not exists(select 1 from public.taxi_offers where ride_id=r.id and driver_id=t.user_id) order by t.available_since,t.user_id for update of t skip locked limit 1;
 if d is null then return;end if;
 insert into public.taxi_offers(ride_id,driver_id) values(r.id,d);
 update public.taxi_rides set status='offered',updated_at=now() where id=r.id;
 update public.taxi_drivers set available_since=now() where user_id=d;
 insert into public.notifications(user_id,category,title,href) values(d,'orders','Предложен заказ такси','#taxi');
end$$;
create function public.request_taxi(p_quote uuid) returns uuid language plpgsql security definer set search_path='' as $$declare q public.taxi_quotes;r public.taxi_rides;w uuid;e uuid;begin
 if not kapani_private.active() or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,52));
 select * into q from public.taxi_quotes where id=p_quote and user_id=auth.uid();if not found then raise exception 'Quote unavailable';end if;
 select * into r from public.taxi_rides where quote_id=q.id;if found then return r.id;end if;
 if q.expires_at<=now() then raise exception 'Quote expired';end if;
 if exists(select 1 from public.taxi_rides where passenger_id=auth.uid() and status not in('completed','cancelled')) then raise exception 'Active ride exists';end if;
 select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';insert into public.accounts(kind) values('escrow') returning id into e;
 perform kapani_private.move_money(w,e,q.amount,auth.uid(),'taxi_reserve');
 insert into public.taxi_rides(quote_id,passenger_id,escrow_id,status) values(q.id,auth.uid(),e,'searching') returning * into r;
 insert into public.taxi_history(ride_id,actor,status) values(r.id,auth.uid(),'searching');perform kapani_private.dispatch_taxi(r.id);return r.id;
end$$;
create function public.respond_taxi_offer(p_offer uuid,p_accept boolean) returns void language plpgsql security definer set search_path='' as $$declare o public.taxi_offers;r public.taxi_rides;begin
 if not kapani_private.has_role('driver') then raise exception 'Access denied';end if;
 select * into o from public.taxi_offers where id=p_offer and driver_id=auth.uid();if not found then raise exception 'Access denied';end if;
 select * into r from public.taxi_rides where id=o.ride_id for update;select * into o from public.taxi_offers where id=p_offer for update;
 if o.status='accepted' and p_accept then return;end if;
 if o.status<>'pending' or o.expires_at<=now() or r.status<>'offered' then raise exception 'Offer expired';end if;
 if p_accept then
 if not exists(select 1 from public.taxi_drivers where user_id=auth.uid() and online) then raise exception 'Driver offline';end if;
 update public.taxi_offers set status='accepted' where id=o.id;update public.taxi_rides set driver_id=auth.uid(),status='accepted',updated_at=now() where id=r.id;
 insert into public.taxi_history(ride_id,actor,status) values(r.id,auth.uid(),'accepted');insert into public.notifications(user_id,category,title,href) values(r.passenger_id,'orders','Водитель принял заказ','#taxi');
 else update public.taxi_offers set status='declined' where id=o.id;update public.taxi_rides set status='searching',updated_at=now() where id=r.id;perform kapani_private.dispatch_taxi(r.id);end if;
end$$;
create function kapani_private.cancel_taxi(p_ride uuid,p_actor uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$declare r public.taxi_rides;q public.taxi_quotes;w uuid;begin
 select * into r from public.taxi_rides where id=p_ride for update;if not found or r.status in('completed','cancelled') then return;end if;
 select * into q from public.taxi_quotes where id=r.quote_id;select id into w from public.accounts where owner_id=r.passenger_id and kind='wallet';perform kapani_private.move_money(r.escrow_id,w,q.amount,p_actor,'taxi_refund');
 update public.taxi_offers set status='expired' where ride_id=r.id and status='pending';update public.taxi_rides set status='cancelled',updated_at=now() where id=r.id;
 update public.taxi_drivers set latitude=null,longitude=null,location_at=null where user_id=r.driver_id;
 insert into public.taxi_history(ride_id,actor,status,reason) values(r.id,p_actor,'cancelled',p_reason);
 insert into public.notifications(user_id,category,title,body,href) values(r.passenger_id,'orders','Поездка отменена, резерв возвращён',p_reason,'#taxi');
end$$;
create function public.taxi_action(p_ride uuid,p_action text,p_reason text default '') returns text language plpgsql security definer set search_path='' as $$declare r public.taxi_rides;q public.taxi_quotes;w uuid;t uuid;expected text;begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into r from public.taxi_rides where id=p_ride for update;if not found then raise exception 'Ride unavailable';end if;
 if p_action='cancel' then
 if auth.uid() not in(r.passenger_id,coalesce(r.driver_id,r.passenger_id)) and not kapani_private.mayor() then raise exception 'Access denied';end if;
 if r.status='completed' or (r.status='in_progress' and not kapani_private.mayor()) then raise exception 'Contact support';end if;
 perform kapani_private.cancel_taxi(r.id,auth.uid(),p_reason);return 'cancelled';end if;
 if r.driver_id is distinct from auth.uid() or not kapani_private.has_role('driver') then raise exception 'Access denied';end if;
 expected:=case p_action when 'arriving' then 'accepted' when 'waiting' then 'arriving' when 'in_progress' then 'waiting' when 'completed' then 'in_progress' end;
 if expected is null then raise exception 'Invalid action';end if;if r.status=p_action then return r.status;end if;if r.status<>expected then raise exception 'Invalid transition';end if;
 if p_action='completed' then
 select * into q from public.taxi_quotes where id=r.quote_id;select id into w from public.accounts where owner_id=r.driver_id and kind='wallet';select id into t from public.accounts where kind='treasury';
 perform kapani_private.move_money(r.escrow_id,w,q.amount-q.commission,auth.uid(),'taxi_driver_payment');if q.commission>0 then perform kapani_private.move_money(r.escrow_id,t,q.commission,auth.uid(),'taxi_commission');end if;
 update public.taxi_drivers set latitude=null,longitude=null,location_at=null where user_id=r.driver_id;
 end if;
 update public.taxi_rides set status=p_action,updated_at=now() where id=r.id;insert into public.taxi_history(ride_id,actor,status,reason) values(r.id,auth.uid(),p_action,p_reason);
 insert into public.notifications(user_id,category,title,body,href) values(r.passenger_id,'orders','Статус поездки изменён',p_action,'#taxi');return p_action;
end$$;
create function public.update_taxi_location(p_lat numeric,p_lng numeric) returns void language plpgsql security definer set search_path='' as $$begin
 if not kapani_private.has_role('driver') or not exists(select 1 from public.taxi_rides where driver_id=auth.uid() and status in('accepted','arriving','waiting','in_progress')) then raise exception 'Access denied';end if;
 update public.taxi_drivers set latitude=p_lat,longitude=p_lng,location_at=now() where user_id=auth.uid() and share_location;if not found then raise exception 'Location sharing disabled';end if;
end$$;
create function public.taxi_driver_info(p_ride uuid) returns table(display_name text,vehicle text,plate text,latitude numeric,longitude numeric,location_at timestamptz) language sql stable security definer set search_path='' as $$
 select p.display_name,d.vehicle,d.plate,case when d.share_location and d.location_at>now()-interval '2 minutes' and r.status not in('completed','cancelled') then d.latitude end,case when d.share_location and d.location_at>now()-interval '2 minutes' and r.status not in('completed','cancelled') then d.longitude end,d.location_at from public.taxi_rides r join public.taxi_drivers d on d.user_id=r.driver_id join public.profiles p on p.id=d.user_id where r.id=p_ride and kapani_private.active() and (r.passenger_id=auth.uid() or r.driver_id=auth.uid())
$$;
create function kapani_private.taxi_tick() returns void language plpgsql security definer set search_path='' as $$declare r record;begin
 for r in select id,status,created_at from public.taxi_rides where status in('searching','offered') order by created_at for update skip locked limit 100 loop
 if r.created_at<now()-interval '10 minutes' then perform kapani_private.cancel_taxi(r.id,null,'Водитель не найден за 10 минут');continue;end if;
 if r.status='offered' and exists(select 1 from public.taxi_offers where ride_id=r.id and status='pending' and expires_at<=now()) then update public.taxi_offers set status='expired' where ride_id=r.id and status='pending';update public.taxi_rides set status='searching' where id=r.id;end if;
 perform kapani_private.dispatch_taxi(r.id);
 end loop;
end$$;
revoke all on function kapani_private.dispatch_taxi(uuid),kapani_private.cancel_taxi(uuid,uuid,text),kapani_private.taxi_tick() from public,anon,authenticated;
revoke all on function public.set_taxi_driver(text,text,boolean,boolean),public.request_taxi(uuid),public.respond_taxi_offer(uuid,boolean),public.taxi_action(uuid,text,text),public.update_taxi_location(numeric,numeric),public.taxi_driver_info(uuid) from public,anon,authenticated;
grant execute on function public.set_taxi_driver(text,text,boolean,boolean),public.request_taxi(uuid),public.respond_taxi_offer(uuid,boolean),public.taxi_action(uuid,text,text),public.update_taxi_location(numeric,numeric),public.taxi_driver_info(uuid) to authenticated;
select cron.schedule('kapani-taxi-dispatch','* * * * *','select kapani_private.taxi_tick()');
commit;
