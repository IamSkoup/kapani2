begin;
create table public.task_definitions(id uuid primary key,title text not null check(length(title) between 3 and 160),description text not null check(length(description) between 10 and 2000),condition text not null check(condition in('post_created','purchase_completed','exam_passed')),cadence text not null check(cadence in('once','daily','weekly')),target integer not null check(target between 1 and 100),reward bigint not null check(reward between 1 and 1000000),subscribers_only boolean not null default false,active boolean not null default true,created_by uuid references public.profiles,created_at timestamptz not null default now(),check(condition='purchase_completed' or cadence='once'));
create table public.task_periods(id uuid primary key default gen_random_uuid(),task_id uuid not null references public.task_definitions,starts_at timestamptz not null,ends_at timestamptz,unique(task_id,starts_at),check(ends_at is null or ends_at>starts_at));
create table public.task_events(user_id uuid not null references public.profiles,kind text not null,entity_id uuid not null,occurred_at timestamptz not null default now(),primary key(user_id,kind,entity_id));
create index task_events_progress on public.task_events(user_id,kind,occurred_at);
create table public.task_claims(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles,period_id uuid not null references public.task_periods,reward bigint not null,transaction_id uuid not null unique references public.transactions,created_at timestamptz not null default now(),unique(user_id,period_id));
create index task_claims_period on public.task_claims(period_id);
alter table public.task_definitions enable row level security;
alter table public.task_periods enable row level security;
alter table public.task_events enable row level security;
alter table public.task_claims enable row level security;
revoke all on public.task_definitions,public.task_periods,public.task_events,public.task_claims from anon,authenticated;
grant select on public.task_definitions,public.task_periods,public.task_events,public.task_claims to authenticated;
create policy task_catalog_read on public.task_definitions for select to authenticated using(kapani_private.active());
create policy task_period_read on public.task_periods for select to authenticated using(kapani_private.active());
create policy task_events_own on public.task_events for select to authenticated using(kapani_private.active() and user_id=auth.uid());
create policy task_claims_own on public.task_claims for select to authenticated using(kapani_private.active() and user_id=auth.uid());
create trigger task_events_immutable before update or delete on public.task_events for each row execute function kapani_private.immutable();
create trigger task_claims_immutable before update or delete on public.task_claims for each row execute function kapani_private.immutable();
create trigger task_periods_immutable before update or delete on public.task_periods for each row execute function kapani_private.immutable();
-- A pure calendar helper permits boundary tests without changing the server clock.
create function kapani_private.task_bounds(p_cadence text,p_created timestamptz,p_clock timestamptz) returns table(starts_at timestamptz,ends_at timestamptz) language sql immutable set search_path='' as $$
 select case p_cadence when 'once' then p_created when 'daily' then date_trunc('day',p_clock at time zone 'Europe/Moscow') at time zone 'Europe/Moscow' when 'weekly' then date_trunc('week',p_clock at time zone 'Europe/Moscow') at time zone 'Europe/Moscow' end,
 case p_cadence when 'daily' then (date_trunc('day',p_clock at time zone 'Europe/Moscow')+interval '1 day') at time zone 'Europe/Moscow' when 'weekly' then (date_trunc('week',p_clock at time zone 'Europe/Moscow')+interval '1 week') at time zone 'Europe/Moscow' end
$$;
create function kapani_private.refresh_task_periods() returns void language plpgsql security definer set search_path='' as $$begin
 insert into public.task_periods(task_id,starts_at,ends_at) select t.id,b.starts_at,b.ends_at from public.task_definitions t cross join lateral kapani_private.task_bounds(t.cadence,t.created_at,now()) b where t.active on conflict(task_id,starts_at) do nothing;
end$$;
create function kapani_private.capture_task_event() returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_table_name='posts' then
 insert into public.task_events(user_id,kind,entity_id) values(new.author_id,'post_created',new.id) on conflict do nothing;
 elsif tg_table_name='orders' then
 if new.status='completed' and old.status<>'completed' then insert into public.task_events(user_id,kind,entity_id) values(new.buyer_id,'purchase_completed',new.id) on conflict do nothing;end if;
 elsif tg_table_name='exam_attempts' then
 if new.status='finished' and old.status='running' and new.passed then insert into public.task_events(user_id,kind,entity_id) values(new.user_id,'exam_passed',new.id) on conflict do nothing;end if;
 end if;return new;
end$$;
create trigger task_post_event after insert on public.posts for each row execute function kapani_private.capture_task_event();
create trigger task_purchase_event after update of status on public.orders for each row execute function kapani_private.capture_task_event();
create trigger task_exam_event after update of status on public.exam_attempts for each row execute function kapani_private.capture_task_event();
create function public.create_task(p_id uuid,p_title text,p_description text,p_condition text,p_cadence text,p_target integer,p_reward bigint,p_subscribers boolean) returns uuid language plpgsql security definer set search_path='' as $$declare t public.task_definitions;begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,31));
 select * into t from public.task_definitions where id=p_id;
 if found then
 if (t.title,t.description,t.condition,t.cadence,t.target,t.reward,t.subscribers_only,t.created_by) is distinct from (p_title,p_description,p_condition,p_cadence,p_target,p_reward,p_subscribers,auth.uid()) then raise exception 'Idempotency conflict';end if;return t.id;end if;
 insert into public.task_definitions(id,title,description,condition,cadence,target,reward,subscribers_only,created_by) values(p_id,p_title,p_description,p_condition,p_cadence,p_target,p_reward,p_subscribers,auth.uid());
 perform kapani_private.refresh_task_periods();
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'task_created',p_id);return p_id;
end$$;
create function public.set_task_active(p_id uuid,p_active boolean) returns void language plpgsql security definer set search_path='' as $$begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 update public.task_definitions set active=p_active where id=p_id;
 if not found then raise exception 'Task unavailable';end if;
 perform kapani_private.refresh_task_periods();
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'task_active',p_id,jsonb_build_object('active',p_active));
end$$;
create function public.my_tasks() returns table(period_id uuid,task_id uuid,title text,description text,cadence text,target integer,progress bigint,reward bigint,ends_at timestamptz,subscribers_only boolean,eligible boolean,claimed boolean) language plpgsql security definer set search_path='' as $$begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 perform kapani_private.refresh_task_periods();
 return query select p.id,t.id,t.title,t.description,t.cadence,t.target,
 (select count(*) from public.task_events e where e.user_id=auth.uid() and e.kind=t.condition and e.occurred_at>=greatest(p.starts_at,t.created_at) and (p.ends_at is null or e.occurred_at<p.ends_at)),t.reward,p.ends_at,t.subscribers_only,
 (select verified from public.profiles where id=auth.uid()) and t.created_by is distinct from auth.uid() and (not t.subscribers_only or exists(select 1 from public.user_subscriptions s where s.user_id=auth.uid() and s.expires_at>now())),
 exists(select 1 from public.task_claims c where c.user_id=auth.uid() and c.period_id=p.id)
 from public.task_periods p join public.task_definitions t on t.id=p.task_id where t.active and p.starts_at<=now() and (p.ends_at is null or p.ends_at>now()) order by t.created_at desc limit 100;
end$$;
create function public.claim_task(p_period uuid) returns uuid language plpgsql security definer set search_path='' as $$declare p public.task_periods;t public.task_definitions;c public.task_claims;w uuid;tx uuid;n bigint;begin
 if not kapani_private.active() or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_period::text,32));
 select * into c from public.task_claims where user_id=auth.uid() and period_id=p_period;if found then return c.id;end if;
 select * into p from public.task_periods where id=p_period;
 select * into t from public.task_definitions where id=p.task_id for share;
 if t.id is null or not t.active or t.created_by=auth.uid() or p.starts_at>now() or p.ends_at<=now() then raise exception 'Task unavailable';end if;
 if t.subscribers_only and not exists(select 1 from public.user_subscriptions where user_id=auth.uid() and expires_at>now()) then raise exception 'Subscription required';end if;
 select count(*) into n from public.task_events e where e.user_id=auth.uid() and e.kind=t.condition and e.occurred_at>=greatest(p.starts_at,t.created_at) and (p.ends_at is null or e.occurred_at<p.ends_at);
 if n<t.target then raise exception 'Task incomplete';end if;
 select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';
 tx:=kapani_private.issue(w,t.reward,auth.uid(),'task_reward',now());
 insert into public.task_claims(user_id,period_id,reward,transaction_id) values(auth.uid(),p.id,t.reward,tx) returning * into c;
 insert into public.notifications(user_id,category,title,body,href) values(auth.uid(),'tasks','Награда за задание',t.title,'#tasks');
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'task_reward',c.id,jsonb_build_object('period',p.id,'transaction',tx));return c.id;
end$$;
revoke all on function kapani_private.task_bounds(text,timestamptz,timestamptz),kapani_private.refresh_task_periods(),kapani_private.capture_task_event() from public,anon,authenticated;
revoke all on function public.create_task(uuid,text,text,text,text,integer,bigint,boolean),public.set_task_active(uuid,boolean),public.my_tasks(),public.claim_task(uuid) from public,anon,authenticated;
grant execute on function public.create_task(uuid,text,text,text,text,integer,bigint,boolean),public.set_task_active(uuid,boolean),public.my_tasks(),public.claim_task(uuid) to authenticated;
select cron.schedule('kapani-task-periods','* * * * *','select kapani_private.refresh_task_periods()');
commit;
