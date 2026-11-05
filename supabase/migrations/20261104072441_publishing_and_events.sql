begin;
create table public.news (
 id uuid primary key,author_id uuid not null references public.profiles,
 category text not null check(category in('village','lands')),
 title text not null check(length(title) between 3 and 160),body text not null check(length(body) between 1 and 40000),
 status text not null default 'draft' check(status in('draft','published','archived')),
 pinned boolean not null default false,discussion_id uuid not null unique references public.conversations,
 published_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index news_timeline on public.news(status,pinned desc,published_at desc,id);
create table public.news_views(news_id uuid references public.news,user_id uuid references public.profiles,created_at timestamptz not null default now(),primary key(news_id,user_id));
create table public.events (
 id uuid primary key,created_by uuid not null references public.profiles,title text not null check(length(title) between 3 and 160),
 description text not null check(length(description) between 1 and 20000),starts_at timestamptz not null,ends_at timestamptz not null,
 registration_until timestamptz not null,capacity integer not null check(capacity between 1 and 10000),
 address text not null default '',latitude numeric check(latitude between -90 and 90),longitude numeric check(longitude between -180 and 180),
 status text not null default 'open' check(status in('open','closed','completed','cancelled')),result_text text,
 created_at timestamptz not null default now(),check(ends_at>starts_at),check(registration_until<=starts_at),check((latitude is null)=(longitude is null))
);
create index events_calendar on public.events(starts_at,id);
create table public.event_participants(event_id uuid references public.events,user_id uuid references public.profiles,status text not null check(status in('registered','withdrawn','attended')),group_name text not null default '',rank integer check(rank>0),created_at timestamptz not null default now(),primary key(event_id,user_id));
create index event_user on public.event_participants(user_id,event_id);
do $$declare t text;begin foreach t in array array['news','news_views','events','event_participants'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);end loop;end $$;
create policy news_read on public.news for select to authenticated using(kapani_private.active() and (status='published' or author_id=auth.uid() or kapani_private.mayor()));
create policy news_views_read on public.news_views for select to authenticated using(user_id=auth.uid() and kapani_private.active());
create policy events_read on public.events for select to authenticated using(kapani_private.active());
create policy event_participants_read on public.event_participants for select to authenticated using(kapani_private.active());
create or replace function kapani_private.member(c uuid) returns boolean language sql stable security definer set search_path='' as $$
 select kapani_private.active() and exists(select 1 from public.conversations x where x.id=c and
 (x.kind='public' or (x.kind='news' and exists(select 1 from public.news n where n.discussion_id=x.id and (n.status='published' or n.author_id=auth.uid() or kapani_private.mayor())))
 or (x.kind in('direct','group') and exists(select 1 from public.conversation_members m where m.conversation_id=x.id and m.user_id=auth.uid()))))
$$;
create function public.save_news(p_id uuid,p_category text,p_title text,p_body text,p_publish boolean default false,p_pinned boolean default false) returns uuid language plpgsql security definer set search_path='' as $$
declare n public.news;c uuid;
begin
 if not kapani_private.active() or not (kapani_private.mayor() or (kapani_private.has_role('journalist') and p_category='village')) then raise exception 'Access denied';end if;
 if p_id is null or p_publish is null or p_pinned is null then raise exception 'Invalid request';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,9));
 select * into n from public.news where id=p_id for update;
 if found and not kapani_private.mayor() and (n.author_id<>auth.uid() or n.category<>'village') then raise exception 'Access denied';end if;
 if p_pinned and not kapani_private.mayor() then raise exception 'Access denied';end if;
 if n.id is null then
  insert into public.conversations(kind,title) values('news',p_title) returning id into c;
  insert into public.news(id,author_id,category,title,body,discussion_id) values(p_id,auth.uid(),p_category,p_title,p_body,c);
 else c:=n.discussion_id;end if;
 update public.news set category=p_category,title=p_title,body=p_body,status=case when p_publish then 'published' else 'draft' end,pinned=p_pinned,published_at=case when p_publish then coalesce(published_at,now()) else published_at end,updated_at=now() where id=p_id;
 update public.conversations set title=p_title where id=c;
 if p_publish and p_pinned and (n.id is null or n.published_at is null) then
  insert into public.notifications(user_id,category,title,href) select id,'news','Важная новость: '||p_title,'#news' from public.profiles where not blocked;
 end if;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'news.save',p_id,jsonb_build_object('published',p_publish,'category',p_category));
 return p_id;
end $$;
create function public.archive_news(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 update public.news set status='archived',updated_at=now() where id=p_id and (kapani_private.mayor() or (author_id=auth.uid() and category='village' and kapani_private.has_role('journalist')));
 if not found then raise exception 'Access denied';end if;
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'news.archive',p_id);
end $$;
create function public.view_news(p_id uuid) returns bigint language plpgsql security definer set search_path='' as $$
begin
 if not kapani_private.active() or not exists(select 1 from public.news where id=p_id and status='published') then raise exception 'Access denied';end if;
 insert into public.news_views(news_id,user_id) values(p_id,auth.uid()) on conflict do nothing;
 return(select count(*) from public.news_views where news_id=p_id);
end $$;
create function public.create_event(p_id uuid,p_title text,p_description text,p_start timestamptz,p_end timestamptz,p_until timestamptz,p_capacity integer,p_address text default '',p_latitude numeric default null,p_longitude numeric default null) returns uuid language plpgsql security definer set search_path='' as $$
declare old public.events;
begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 if p_id is null or p_start<=now() then raise exception 'Invalid event date';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,10));
 select * into old from public.events where id=p_id;
 if found then
  if old.created_by<>auth.uid() or (old.title,old.description,old.starts_at,old.ends_at,old.registration_until,old.capacity,old.address,old.latitude,old.longitude) is distinct from (p_title,p_description,p_start,p_end,p_until,p_capacity,p_address,p_latitude,p_longitude) then raise exception 'Idempotency conflict';end if;
  return old.id;
 end if;
 insert into public.events(id,created_by,title,description,starts_at,ends_at,registration_until,capacity,address,latitude,longitude) values(p_id,auth.uid(),p_title,p_description,p_start,p_end,p_until,p_capacity,p_address,p_latitude,p_longitude);
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'event.create',p_id);return p_id;
end $$;
create function public.join_event(p_id uuid,p_withdraw boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare e public.events;p public.event_participants;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into e from public.events where id=p_id for update;
 if not found then raise exception 'Event unavailable';end if;
 select * into p from public.event_participants where event_id=p_id and user_id=auth.uid();
 if not p_withdraw and p.status in('registered','attended') then return;end if;
 if p_withdraw and (p.user_id is null or p.status='withdrawn') then return;end if;
 if e.status<>'open' or e.registration_until<=now() then raise exception 'Registration closed';end if;
 if not p_withdraw and (select count(*) from public.event_participants where event_id=p_id and status in('registered','attended'))>=e.capacity then raise exception 'Event is full';end if;
 insert into public.event_participants(event_id,user_id,status) values(p_id,auth.uid(),case when p_withdraw then 'withdrawn' else 'registered' end)
 on conflict(event_id,user_id) do update set status=excluded.status;
 insert into public.notifications(user_id,category,title,href) values(auth.uid(),'events',case when p_withdraw then 'Регистрация отменена' else 'Регистрация на событие подтверждена' end,'#events');
end $$;
create function public.event_action(p_id uuid,p_status text,p_result text default '') returns void language plpgsql security definer set search_path='' as $$
declare e public.events;
begin
 if not kapani_private.mayor() or p_status not in('closed','completed','cancelled') then raise exception 'Access denied';end if;
 select * into e from public.events where id=p_id for update;
 if not found then raise exception 'Event unavailable';end if;
 if e.status=p_status then return;end if;
 if e.status in('completed','cancelled') or (p_status='completed' and (e.ends_at>now() or length(trim(p_result))<5)) then raise exception 'Invalid transition';end if;
 update public.events set status=p_status,result_text=p_result where id=p_id;
 insert into public.notifications(user_id,category,title,body,href) select user_id,'events',e.title,case p_status when 'closed' then 'Регистрация закрыта. ' when 'completed' then 'Событие завершено. ' else 'Событие отменено. ' end||p_result,'#events' from public.event_participants where event_id=p_id and status<>'withdrawn';
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'event.'||p_status,p_id,jsonb_build_object('result',p_result));
end $$;
create function public.event_participant_result(p_id uuid,p_user uuid,p_group text,p_attended boolean,p_rank integer default null) returns void language plpgsql security definer set search_path='' as $$
declare e public.events;
begin
 if not kapani_private.mayor() or p_attended is null or length(p_group)>80 then raise exception 'Access denied';end if;
 select * into e from public.events where id=p_id for update;
 if not found or e.status in('cancelled','completed') or (p_attended and e.starts_at>now()) then raise exception 'Invalid transition';end if;
 update public.event_participants set group_name=p_group,status=case when p_attended then 'attended' else 'registered' end,rank=case when p_attended then p_rank else null end where event_id=p_id and user_id=p_user and status<>'withdrawn';
 if not found then raise exception 'Participant unavailable';end if;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'event.participant',p_id,jsonb_build_object('user',p_user,'group',p_group,'rank',p_rank,'attended',p_attended));
end $$;
revoke all on function public.save_news(uuid,text,text,text,boolean,boolean),public.archive_news(uuid),public.view_news(uuid),public.create_event(uuid,text,text,timestamptz,timestamptz,timestamptz,integer,text,numeric,numeric),public.join_event(uuid,boolean),public.event_action(uuid,text,text),public.event_participant_result(uuid,uuid,text,boolean,integer) from public,anon;
grant execute on function public.save_news(uuid,text,text,text,boolean,boolean),public.archive_news(uuid),public.view_news(uuid),public.create_event(uuid,text,text,timestamptz,timestamptz,timestamptz,integer,text,numeric,numeric),public.join_event(uuid,boolean),public.event_action(uuid,text,text),public.event_participant_result(uuid,uuid,text,boolean,integer) to authenticated;
create or replace function public.conversation_list() returns table(id uuid,title text,kind text,last_body text,last_at timestamptz,unread bigint,pinned boolean) language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 return query select c.id,coalesce(c.title,(select p.display_name from public.conversation_members cm join public.profiles p on p.id=cm.user_id where cm.conversation_id=c.id and cm.user_id<>auth.uid() limit 1),'Переписка'),c.kind,
 case when m.deleted_at is null then left(m.body,160) else 'Сообщение удалено' end,coalesce(m.created_at,c.created_at),
 (select count(*) from public.messages x where x.conversation_id=c.id and x.author_id<>auth.uid() and x.deleted_at is null and x.created_at>coalesce(own.read_at,'-infinity'::timestamptz)),coalesce(own.pinned,false)
 from public.conversations c left join public.conversation_members own on own.conversation_id=c.id and own.user_id=auth.uid()
 left join lateral(select mm.* from public.messages mm where mm.conversation_id=c.id order by mm.created_at desc,mm.id desc limit 1)m on true
 where (c.kind='public' or own.user_id is not null) and kapani_private.member(c.id)
 order by coalesce(own.pinned,false) desc,coalesce(m.created_at,c.created_at) desc,c.id limit 50;
end $$;
commit;
