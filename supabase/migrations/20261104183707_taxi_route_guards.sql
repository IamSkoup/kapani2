begin;
create or replace function kapani_private.cancel_taxi(p_ride uuid,p_actor uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$declare r public.taxi_rides;q public.taxi_quotes;w uuid;begin
 select * into r from public.taxi_rides where id=p_ride for update;if not found or r.status in('completed','cancelled') then return;end if;
 select * into q from public.taxi_quotes where id=r.quote_id;select id into w from public.accounts where owner_id=r.passenger_id and kind='wallet';perform kapani_private.move_money(r.escrow_id,w,q.amount,coalesce(p_actor,r.passenger_id),'taxi_refund');
 update public.taxi_offers set status='expired' where ride_id=r.id and status='pending';update public.taxi_rides set status='cancelled',updated_at=now() where id=r.id;
 update public.taxi_drivers set latitude=null,longitude=null,location_at=null where user_id=r.driver_id;
 insert into public.audit_log(actor,action,entity,details) values(p_actor,'taxi.cancel',r.id,jsonb_build_object('reason',p_reason));
 insert into public.taxi_history(ride_id,actor,status,reason) values(r.id,p_actor,'cancelled',p_reason);
 insert into public.notifications(user_id,category,title,body,href) values(r.passenger_id,'orders','Поездка отменена, резерв возвращён',p_reason,'#taxi');
end$$;

create or replace function public.store_taxi_quote(p_user uuid,p_pickup_lat numeric,p_pickup_lng numeric,p_dropoff_lat numeric,p_dropoff_lng numeric,p_distance integer,p_duration integer,p_provider text,p_geometry jsonb) returns public.taxi_quotes language plpgsql security definer set search_path='' as $$declare rate public.taxi_rates;q public.taxi_quotes;amount bigint;begin
 if not exists(select 1 from public.profiles where id=p_user and verified and not blocked) then raise exception 'Municipal verification required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,51));
 if (select count(*) from public.taxi_quotes where user_id=p_user and created_at>now()-interval '1 hour')>=30 then raise exception 'Rate limit';end if;
 if p_geometry is null or coalesce(p_geometry->>'type','')<>'LineString' or jsonb_typeof(p_geometry->'coordinates')<>'array' or jsonb_array_length(p_geometry->'coordinates') not between 2 and 20000 or length(p_geometry::text)>2000000 then raise exception 'Invalid route';end if;
 select * into rate from public.taxi_rates order by created_at desc,id desc limit 1;
 amount:=rate.base_amount+ceil(p_distance::numeric*rate.per_km/1000)::bigint+ceil(p_duration::numeric*rate.per_minute/60)::bigint;
 insert into public.taxi_quotes(user_id,rate_id,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,distance_m,duration_s,amount,commission,provider,geometry) values(p_user,rate.id,p_pickup_lat,p_pickup_lng,p_dropoff_lat,p_dropoff_lng,p_distance,p_duration,amount,floor(amount*rate.commission_percent::numeric/100)::bigint,p_provider,p_geometry) returning * into q;return q;
end$$;

create function public.reserve_taxi_route(p_user uuid) returns boolean language plpgsql security definer set search_path='' as $$declare n integer;begin
 if not exists(select 1 from public.profiles where id=p_user and verified and not blocked) then return false;end if;
 insert into kapani_private.login_rate_buckets(bucket,period,attempts) values('route:'||p_user::text,date_trunc('hour',now()),1) on conflict(bucket,period) do update set attempts=kapani_private.login_rate_buckets.attempts+1 returning attempts into n;return n<=30;
end$$;
revoke all on function public.reserve_taxi_route(uuid) from public,anon,authenticated;
grant execute on function public.reserve_taxi_route(uuid) to service_role;
create function kapani_private.audit_taxi_state() returns trigger language plpgsql security definer set search_path='' as $$begin
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'taxi.state',new.id,jsonb_build_object('status',new.status));return new;
end$$;
revoke all on function kapani_private.audit_taxi_state() from public,anon,authenticated;
create trigger taxi_state_audit after insert or update of status on public.taxi_rides for each row execute function kapani_private.audit_taxi_state();
commit;