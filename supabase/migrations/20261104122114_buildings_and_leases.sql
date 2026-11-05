begin;
create extension if not exists btree_gist with schema extensions;
create table public.buildings(id uuid primary key,title text not null check(length(title) between 3 and 160),description text not null,address text not null,daily_price bigint not null check(daily_price between 1 and 10000000),latitude numeric check(latitude between -90 and 90),longitude numeric check(longitude between -180 and 180),active boolean not null default true,created_at timestamptz not null default now(),check((latitude is null)=(longitude is null)));
create table public.building_tariffs(id uuid primary key default gen_random_uuid(),building_id uuid not null references public.buildings,daily_price bigint not null,actor uuid not null references public.profiles,created_at timestamptz not null default now());
create table public.leases(id uuid primary key default gen_random_uuid(),building_id uuid not null references public.buildings,tenant_id uuid not null references public.profiles,starts_on date not null,ends_on date not null,status text not null default 'active' check(status in('active','released','expired','cancelled')),escrow_id uuid not null unique references public.accounts,settled_at timestamptz,created_at timestamptz not null default now(),check(ends_on>starts_on),exclude using gist(building_id extensions.gist_uuid_ops with =,daterange(starts_on,ends_on,'[)') with &&) where(status='active'));
create index leases_tenant on public.leases(tenant_id,created_at desc);
create index leases_schedule on public.leases(status,starts_on,ends_on);
create table public.lease_payments(id uuid primary key default gen_random_uuid(),lease_id uuid not null references public.leases,actor uuid not null references public.profiles,kind text not null check(kind in('rent','renew')),starts_on date not null,ends_on date not null,daily_price bigint not null,amount bigint not null,transaction_id uuid not null unique references public.transactions,idempotency_key uuid not null,created_at timestamptz not null default now(),unique(actor,idempotency_key));
create table public.lease_notices(lease_id uuid references public.leases,kind text not null,notice_date date not null,primary key(lease_id,kind,notice_date));
do $$declare t text;begin foreach t in array array['buildings','building_tariffs','leases','lease_payments','lease_notices'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);end loop;end $$;
create policy buildings_read on public.buildings for select to authenticated using(kapani_private.active());
create policy building_tariffs_read on public.building_tariffs for select to authenticated using(kapani_private.active());
create policy leases_read on public.leases for select to authenticated using(kapani_private.active() and (tenant_id=auth.uid() or kapani_private.mayor()));
create policy lease_payments_read on public.lease_payments for select to authenticated using(kapani_private.active() and (actor=auth.uid() or kapani_private.mayor()));
create policy lease_notices_read on public.lease_notices for select to authenticated using(exists(select 1 from public.leases where id=lease_id and tenant_id=auth.uid() and kapani_private.active()));
create trigger lease_payments_immutable before update or delete on public.lease_payments for each row execute function kapani_private.immutable();
create trigger building_tariffs_immutable before update or delete on public.building_tariffs for each row execute function kapani_private.immutable();
alter table public.businesses add column lease_id uuid references public.leases;
create function public.save_building(p_id uuid,p_title text,p_description text,p_address text,p_daily bigint,p_active boolean,p_latitude numeric default null,p_longitude numeric default null) returns uuid language plpgsql security definer set search_path='' as $$
declare old_price bigint;
begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 select daily_price into old_price from public.buildings where id=p_id for update;
 insert into public.buildings(id,title,description,address,daily_price,active,latitude,longitude) values(p_id,p_title,p_description,p_address,p_daily,p_active,p_latitude,p_longitude)
 on conflict(id) do update set title=excluded.title,description=excluded.description,address=excluded.address,daily_price=excluded.daily_price,active=excluded.active,latitude=excluded.latitude,longitude=excluded.longitude;
 if old_price is distinct from p_daily then insert into public.building_tariffs(building_id,daily_price,actor) values(p_id,p_daily,auth.uid());end if;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'building.save',p_id,jsonb_build_object('daily_price',p_daily,'active',p_active));return p_id;
end $$;
create function public.available_buildings(p_start date,p_days integer) returns setof public.buildings language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.active() or p_start is null or p_days is null or p_days not between 1 and 365 then raise exception 'Invalid request';end if;
 return query select b.* from public.buildings b where b.active and not exists(select 1 from public.leases l where l.building_id=b.id and l.status='active' and daterange(l.starts_on,l.ends_on,'[)')&&daterange(p_start,p_start+p_days,'[)')) order by b.title,b.id limit 100;
end $$;
create function public.rent_building(p_building uuid,p_start date,p_days integer,p_expected_daily bigint,p_key uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.buildings;prev public.lease_payments;l uuid;esc uuid;wallet uuid;treasury uuid;tx uuid;cost bigint;today date:=(now() at time zone 'Europe/Moscow')::date;
begin
 if not kapani_private.active() or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
 if p_key is null or p_start is null or p_days is null or p_days not between 1 and 365 then raise exception 'Invalid rental term';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,13));
 select * into prev from public.lease_payments where actor=auth.uid() and idempotency_key=p_key;
 if found then
 if prev.kind<>'rent' or prev.starts_on<>p_start or prev.ends_on<>p_start+p_days or prev.daily_price<>p_expected_daily or not exists(select 1 from public.leases where id=prev.lease_id and building_id=p_building) then raise exception 'Idempotency conflict';end if;return prev.lease_id;
 end if;
 if p_start<today or p_start>today+90 then raise exception 'Invalid rental term';end if;
 select * into b from public.buildings where id=p_building and active for update;
 if not found then raise exception 'Building unavailable';end if;
 if p_expected_daily is null or p_expected_daily<>b.daily_price then raise exception 'Price changed';end if;
 if exists(select 1 from public.leases where building_id=b.id and status='active' and daterange(starts_on,ends_on,'[)')&&daterange(p_start,p_start+p_days,'[)')) then raise exception 'Building already reserved';end if;
 cost:=b.daily_price*p_days;
 insert into public.accounts(kind) values('escrow') returning id into esc;
 insert into public.leases(building_id,tenant_id,starts_on,ends_on,escrow_id) values(b.id,auth.uid(),p_start,p_start+p_days,esc) returning id into l;
 select id into wallet from public.accounts where owner_id=auth.uid() and kind='wallet';
 tx:=kapani_private.move_money(wallet,esc,cost,auth.uid(),'building_rent');
 insert into public.lease_payments(lease_id,actor,kind,starts_on,ends_on,daily_price,amount,transaction_id,idempotency_key) values(l,auth.uid(),'rent',p_start,p_start+p_days,b.daily_price,cost,tx,p_key);
 insert into public.notifications(user_id,category,title,href) values(auth.uid(),'rent','Аренда подтверждена','#rentals');
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'lease.create',l,jsonb_build_object('transaction',tx,'amount',cost));return l;
end $$;
create function public.renew_lease(p_lease uuid,p_days integer,p_expected_daily bigint,p_key uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare l public.leases;b public.buildings;prev public.lease_payments;w uuid;dest uuid;tx uuid;v uuid;cost bigint;
begin
 if not kapani_private.active() or p_key is null or p_days is null or p_days not between 1 and 365 then raise exception 'Access denied';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,13));
 select * into prev from public.lease_payments where actor=auth.uid() and idempotency_key=p_key;
 if found then if prev.kind<>'renew' or prev.lease_id<>p_lease or prev.ends_on-prev.starts_on<>p_days or prev.daily_price<>p_expected_daily then raise exception 'Idempotency conflict';end if;return prev.id;end if;
 select * into l from public.leases where id=p_lease and tenant_id=auth.uid();
 if not found then raise exception 'Access denied';end if;
 select * into b from public.buildings where id=l.building_id for update;
 select * into l from public.leases where id=p_lease for update;
 if l.status<>'active' or l.ends_on<=(now() at time zone 'Europe/Moscow')::date or not b.active then raise exception 'Lease unavailable';end if;
 if p_expected_daily is null or p_expected_daily<>b.daily_price then raise exception 'Price changed';end if;
 if exists(select 1 from public.leases where building_id=b.id and id<>l.id and status='active' and daterange(starts_on,ends_on,'[)')&&daterange(l.ends_on,l.ends_on+p_days,'[)')) then raise exception 'Building already reserved';end if;
 cost:=b.daily_price*p_days;select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';
 if l.settled_at is null then dest:=l.escrow_id;else select id into dest from public.accounts where kind='treasury';end if;
 tx:=kapani_private.move_money(w,dest,cost,auth.uid(),'lease_renew');
 insert into public.lease_payments(lease_id,actor,kind,starts_on,ends_on,daily_price,amount,transaction_id,idempotency_key) values(l.id,auth.uid(),'renew',l.ends_on,l.ends_on+p_days,b.daily_price,cost,tx,p_key) returning id into v;
 update public.leases set ends_on=ends_on+p_days where id=l.id;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'lease.renew',l.id,jsonb_build_object('days',p_days,'transaction',tx));return v;
end $$;
create function public.release_lease(p_lease uuid) returns void language plpgsql security definer set search_path='' as $$
declare l public.leases;dest uuid;amount bigint;today date:=(now() at time zone 'Europe/Moscow')::date;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into l from public.leases where id=p_lease and tenant_id=auth.uid() for update;
 if not found then raise exception 'Access denied';end if;
 if l.status<>'active' then return;end if;
 select balance into amount from public.accounts where id=l.escrow_id;
 if today<l.starts_on then select id into dest from public.accounts where owner_id=auth.uid() and kind='wallet';else select id into dest from public.accounts where kind='treasury';end if;
 if amount>0 then perform kapani_private.move_money(l.escrow_id,dest,amount,auth.uid(),case when today<l.starts_on then 'lease_refund' else 'lease_settle' end);end if;
 update public.leases set status=case when today<l.starts_on then 'cancelled' else 'released' end where id=l.id;
 update public.businesses set lease_id=null where lease_id=l.id;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'lease.release',l.id,jsonb_build_object('refunded',case when today<l.starts_on then amount else 0 end));
 insert into public.notifications(user_id,category,title,href) values(auth.uid(),'rent',case when today<l.starts_on then 'Аренда отменена, резерв возвращён' else 'Помещение освобождено' end,'#rentals');
end $$;
create function public.bind_business_lease(p_business uuid,p_lease uuid) returns void language plpgsql security definer set search_path='' as $$
declare l public.leases;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into l from public.leases where id=p_lease and tenant_id=auth.uid() and status='active' and daterange(starts_on,ends_on,'[)')@>(now() at time zone 'Europe/Moscow')::date for update;
 if not found then raise exception 'Active lease required';end if;
 update public.businesses set lease_id=p_lease where id=p_business and owner_id=auth.uid() and status='active';
 if not found then raise exception 'Access denied';end if;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'business.lease',p_business,jsonb_build_object('lease',p_lease));
end $$;
create function kapani_private.lease_jobs() returns void language plpgsql security definer set search_path='' as $$
declare l public.leases;amount bigint;treasury uuid;today date:=(now() at time zone 'Europe/Moscow')::date;inserted integer;
begin
 select id into treasury from public.accounts where kind='treasury';
 for l in select * from public.leases where status='active' for update skip locked loop
 if l.starts_on<=today and l.settled_at is null then
 select balance into amount from public.accounts where id=l.escrow_id;
 if amount>0 then perform kapani_private.move_money(l.escrow_id,treasury,amount,l.tenant_id,'lease_settle');end if;
 update public.leases set settled_at=now() where id=l.id;
 end if;
 if l.ends_on<=today then
 update public.leases set status='expired' where id=l.id;update public.businesses set lease_id=null where lease_id=l.id;
 insert into public.notifications(user_id,category,title,href) values(l.tenant_id,'rent','Срок аренды завершён','#rentals');
 elsif l.ends_on<=today+7 then
 insert into public.lease_notices values(l.id,'expiring',l.ends_on) on conflict do nothing;get diagnostics inserted=row_count;
 if inserted>0 then insert into public.notifications(user_id,category,title,href) values(l.tenant_id,'rent','Срок аренды скоро заканчивается','#rentals');end if;
 end if;
 end loop;
end $$;
revoke all on function kapani_private.lease_jobs() from public,anon,authenticated;
revoke all on function public.save_building(uuid,text,text,text,bigint,boolean,numeric,numeric),public.available_buildings(date,integer),public.rent_building(uuid,date,integer,bigint,uuid),public.renew_lease(uuid,integer,bigint,uuid),public.release_lease(uuid),public.bind_business_lease(uuid,uuid) from public,anon;
grant execute on function public.save_building(uuid,text,text,text,bigint,boolean,numeric,numeric),public.available_buildings(date,integer),public.rent_building(uuid,date,integer,bigint,uuid),public.renew_lease(uuid,integer,bigint,uuid),public.release_lease(uuid),public.bind_business_lease(uuid,uuid) to authenticated;
select cron.schedule('kapani-lease-lifecycle','10 * * * *',$cron$select kapani_private.lease_jobs();$cron$);
commit;
