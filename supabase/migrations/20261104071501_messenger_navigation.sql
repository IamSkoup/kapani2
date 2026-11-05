begin;
create table public.message_reactions(message_id uuid references public.messages,user_id uuid references public.profiles,reaction text not null check(reaction in('like','thanks','support')),primary key(message_id,user_id));
alter table public.message_reactions enable row level security;
revoke all on public.message_reactions from public,anon,authenticated;
grant select,insert,delete on public.message_reactions to authenticated;
grant update(reaction) on public.message_reactions to authenticated;
create policy message_reactions_read on public.message_reactions for select to authenticated using(exists(select 1 from public.messages m where m.id=message_id and kapani_private.member(m.conversation_id) and m.deleted_at is null));
create policy message_reactions_insert on public.message_reactions for insert to authenticated with check(user_id=auth.uid() and exists(select 1 from public.messages m where m.id=message_id and kapani_private.member(m.conversation_id) and m.deleted_at is null));
create policy message_reactions_update on public.message_reactions for update to authenticated using(user_id=auth.uid() and kapani_private.active()) with check(user_id=auth.uid() and exists(select 1 from public.messages m where m.id=message_id and kapani_private.member(m.conversation_id) and m.deleted_at is null));
create policy message_reactions_delete on public.message_reactions for delete to authenticated using(user_id=auth.uid() and kapani_private.active());
revoke update(read_at) on public.conversation_members from authenticated;
create function public.mark_conversation_read(p_conversation uuid,p_message uuid) returns void language plpgsql security definer set search_path='' as $$
declare t timestamptz;
begin
 if not kapani_private.member(p_conversation) then raise exception 'Access denied';end if;
 select created_at into t from public.messages where id=p_message and conversation_id=p_conversation;
 if t is null then return;end if;
 insert into public.conversation_members(conversation_id,user_id,read_at) values(p_conversation,auth.uid(),t)
 on conflict(conversation_id,user_id) do update set read_at=greatest(public.conversation_members.read_at,excluded.read_at);
end $$;
create function public.message_history(p_conversation uuid,p_before timestamptz default null,p_before_id uuid default null,p_search text default '',p_date date default null) returns setof public.messages language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.member(p_conversation) then raise exception 'Access denied';end if;
 if length(p_search)>120 or (p_before is null)<>(p_before_id is null) then raise exception 'Invalid query';end if;
 return query select m.* from public.messages m where m.conversation_id=p_conversation
 and (p_before is null or (m.created_at,m.id)<(p_before,p_before_id))
 and (p_search='' or (m.deleted_at is null and position(lower(p_search) in lower(m.body))>0))
 and (p_date is null or m.created_at>=p_date::timestamp at time zone 'Europe/Moscow' and m.created_at<(p_date+1)::timestamp at time zone 'Europe/Moscow')
 order by m.created_at desc,m.id desc limit 60;
end $$;
create function public.conversation_list() returns table(id uuid,title text,kind text,last_body text,last_at timestamptz,unread bigint,pinned boolean) language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 return query select c.id,coalesce(c.title,(select p.display_name from public.conversation_members cm join public.profiles p on p.id=cm.user_id where cm.conversation_id=c.id and cm.user_id<>auth.uid() limit 1),'Переписка'),c.kind,
 case when m.deleted_at is null then left(m.body,160) else 'Сообщение удалено' end,coalesce(m.created_at,c.created_at),
 (select count(*) from public.messages x where x.conversation_id=c.id and x.author_id<>auth.uid() and x.deleted_at is null and x.created_at>coalesce(own.read_at,'-infinity'::timestamptz)),coalesce(own.pinned,false)
 from public.conversations c left join public.conversation_members own on own.conversation_id=c.id and own.user_id=auth.uid()
 left join lateral(select mm.* from public.messages mm where mm.conversation_id=c.id order by mm.created_at desc,mm.id desc limit 1)m on true
 where c.kind='public' or own.user_id is not null
 order by coalesce(own.pinned,false) desc,coalesce(m.created_at,c.created_at) desc,c.id limit 50;
end $$;
create or replace function public.edit_message(p_id uuid,p_body text,p_delete boolean default false) returns void language plpgsql security definer set search_path='' as $$
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 if not p_delete and (p_body is null or length(p_body)>12000 or (length(trim(p_body))=0 and not exists(select 1 from public.uploads where message_id=p_id))) then raise exception 'Invalid message';end if;
 update public.messages set body=case when p_delete then 'Сообщение удалено' else p_body end,edited_at=now(),deleted_at=case when p_delete then now() else null end where id=p_id and author_id=auth.uid() and deleted_at is null and kapani_private.member(conversation_id);
 if not found and not (p_delete and exists(select 1 from public.messages where id=p_id and author_id=auth.uid() and deleted_at is not null)) then raise exception 'Message unavailable';end if;
end $$;
alter publication supabase_realtime add table public.message_reactions,public.conversation_members;
revoke all on function public.mark_conversation_read(uuid,uuid),public.message_history(uuid,timestamptz,uuid,text,date),public.conversation_list() from public,anon;
grant execute on function public.mark_conversation_read(uuid,uuid),public.message_history(uuid,timestamptz,uuid,text,date),public.conversation_list() to authenticated;
commit;
