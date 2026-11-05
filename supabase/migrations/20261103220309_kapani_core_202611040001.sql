begin;
-- This migration deliberately fails on existing objects; never merges unknown schemas.
create schema kapani_private;
revoke all on schema kapani_private from public, anon, authenticated;
create table public.profiles (
 id uuid primary key references auth.users(id), username text not null,
 display_name text not null, bio text not null default '', avatar_path text, cover_path text,
 verified boolean not null default false, blocked boolean not null default false,
 show_online boolean not null default false, created_at timestamptz not null default now(),
 check (username ~ '^[A-Za-zА-Яа-яЁё0-9_]{3,32}$'), check(length(display_name) between 1 and 80), check(length(bio)<=2000)
);
create unique index profiles_username_unique on public.profiles(lower(username));
create table public.roles(code text primary key, name text not null);
insert into public.roles values ('resident','Житель'),('mayor','Мэр'),('moderator','Модератор'),('journalist','Журналист'),('ksb','КСБ'),('police','Полицейский'),('deputy','Депутат'),('driver','Водитель'),('courier','Курьер'),('doctor','Врач'),('assistant','Помощник врача'),('cleaner','Уборщик'),('advertiser','Рекламщик'),('owner','Владелец бизнеса');
create table public.permissions(code text primary key);
create table public.role_permissions(role text references public.roles, permission text references public.permissions, primary key(role,permission));
create table public.user_roles(user_id uuid references public.profiles,role text references public.roles, assigned_by uuid references public.profiles, created_at timestamptz not null default now(),primary key(user_id,role));
create table public.audit_log(id bigint generated always as identity primary key, actor uuid references public.profiles,action text not null,entity uuid,details jsonb not null default '{}',created_at timestamptz not null default now());
create table public.notifications(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles,category text not null,title text not null,body text not null default '',href text,read_at timestamptz,created_at timestamptz not null default now());
create index notifications_user_time on public.notifications(user_id,created_at desc);
create table public.accounts(id uuid primary key default gen_random_uuid(),owner_id uuid references public.profiles,kind text not null check(kind in ('wallet','savings','treasury','escrow','business')),balance bigint not null default 0 check(balance>=0),created_at timestamptz not null default now());
create unique index account_owner_kind on public.accounts(owner_id,kind) where kind in ('wallet','savings');
create table public.transactions(id uuid primary key default gen_random_uuid(),actor uuid not null references public.profiles,idempotency_key uuid not null,kind text not null,description text not null default '',created_at timestamptz not null default now(),unique(actor,idempotency_key));
create table public.entries(id bigint generated always as identity primary key,transaction_id uuid not null references public.transactions,account_id uuid not null references public.accounts,amount bigint not null check(amount<>0));
create index entries_account on public.entries(account_id,transaction_id);
create table public.conversations(id uuid primary key default gen_random_uuid(),kind text not null check(kind in ('public','direct','group','news')),title text,created_at timestamptz not null default now());
create table public.conversation_members(conversation_id uuid references public.conversations,user_id uuid references public.profiles,read_at timestamptz,pinned boolean not null default false,primary key(conversation_id,user_id));
create index members_user on public.conversation_members(user_id);
create table public.messages(id uuid primary key,conversation_id uuid not null references public.conversations,author_id uuid not null references public.profiles,body text not null check(length(body) between 1 and 12000),reply_to uuid references public.messages,created_at timestamptz not null default now(),edited_at timestamptz,deleted_at timestamptz);
create index messages_history on public.messages(conversation_id,created_at desc,id);
create table public.posts(id uuid primary key default gen_random_uuid(),author_id uuid not null references public.profiles,body text not null check(length(body) between 1 and 20000),visibility text not null default 'residents' check(visibility in ('residents','private')),created_at timestamptz not null default now());
create table public.post_comments(id uuid primary key default gen_random_uuid(),post_id uuid not null references public.posts,author_id uuid not null references public.profiles,body text not null check(length(body) between 1 and 4000),created_at timestamptz not null default now());
create table public.post_reactions(post_id uuid references public.posts,user_id uuid references public.profiles,reaction text not null check(reaction in ('like','thanks','support')),primary key(post_id,user_id));
create function kapani_private.active() returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.profiles where id=auth.uid() and not blocked) $$;
create function kapani_private.mayor() returns boolean language sql stable security definer set search_path='' as $$ select kapani_private.active() and exists(select 1 from public.user_roles where user_id=auth.uid() and role='mayor') $$;
create function kapani_private.member(c uuid) returns boolean language sql stable security definer set search_path='' as $$ select kapani_private.active() and exists(select 1 from public.conversations x where x.id=c and (x.kind='public' or exists(select 1 from public.conversation_members m where m.conversation_id=x.id and m.user_id=auth.uid()))) $$;
create function kapani_private.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,username,display_name) values(new.id,new.raw_user_meta_data->>'username',new.raw_user_meta_data->>'username');
 insert into public.user_roles(user_id,role) values(new.id,'resident');
 insert into public.accounts(owner_id,kind) values(new.id,'wallet'),(new.id,'savings');
 return new;
end $$;
create trigger kapani_signup after insert on auth.users for each row execute function kapani_private.on_signup();
create function kapani_private.immutable() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Immutable ledger'; end $$;
create trigger immutable_entries before update or delete on public.entries for each row execute function kapani_private.immutable();
create trigger immutable_transactions before update or delete on public.transactions for each row execute function kapani_private.immutable();
create trigger immutable_audit before update or delete on public.audit_log for each row execute function kapani_private.immutable();
create function kapani_private.balance_check() returns trigger language plpgsql set search_path='' as $$ begin if (select coalesce(sum(amount),0) from public.entries where transaction_id=new.transaction_id)<>0 then raise exception 'Unbalanced journal'; end if; return null; end $$;
create constraint trigger balanced_journal after insert on public.entries deferrable initially deferred for each row execute function kapani_private.balance_check();
create function public.transfer(p_recipient text,p_amount bigint,p_key uuid,p_savings text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare sender uuid; receiver uuid; tx uuid; recipient uuid; old_tx public.transactions; expected_kind text;
begin
 if not kapani_private.active() then raise exception 'Access denied'; end if;
 if p_amount is null or p_amount<=0 or p_amount>100000000000 then raise exception 'Invalid amount'; end if;
 if p_key is null then raise exception 'Idempotency key required'; end if;
 if p_savings is not null and p_savings not in ('deposit','withdraw') then raise exception 'Invalid operation'; end if;
 expected_kind:=coalesce(p_savings,'transfer');
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
 select * into old_tx from public.transactions where actor=auth.uid() and idempotency_key=p_key;
 select id into recipient from public.profiles where lower(username)=lower(p_recipient) and not blocked;
 if p_savings is not null then recipient:=auth.uid(); end if;
 if recipient is null or (recipient=auth.uid() and p_savings is null) then raise exception 'Invalid recipient'; end if;
 select id into sender from public.accounts where owner_id=auth.uid() and kind=case when p_savings='withdraw' then 'savings' else 'wallet' end;
 select id into receiver from public.accounts where owner_id=recipient and kind=case when p_savings='deposit' then 'savings' else 'wallet' end;
 if old_tx.id is not null then
   if old_tx.kind<>expected_kind or not exists(select 1 from public.entries where transaction_id=old_tx.id and account_id=sender and amount=-p_amount) or not exists(select 1 from public.entries where transaction_id=old_tx.id and account_id=receiver and amount=p_amount) then raise exception 'Idempotency conflict'; end if;
   return old_tx.id;
 end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required'; end if;
 perform 1 from public.accounts where id in (sender,receiver) order by id for update;
 if sender is null or receiver is null then raise exception 'Account missing'; end if;
 if (select balance from public.accounts where id=sender)<p_amount then raise exception 'Insufficient funds'; end if;
 insert into public.transactions(actor,idempotency_key,kind,description) values(auth.uid(),p_key,expected_kind,'Внутренняя валюта Капани') returning id into tx;
 insert into public.entries(transaction_id,account_id,amount) values(tx,sender,-p_amount),(tx,receiver,p_amount);
 update public.accounts set balance=balance-p_amount where id=sender;
 update public.accounts set balance=balance+p_amount where id=receiver;
 insert into public.notifications(user_id,category,title,href) values(recipient,'finance','Зачисление на счёт','#bank');
 insert into public.audit_log(actor,action,entity) values(auth.uid(),expected_kind,tx);
 return tx;
end $$;
create function public.open_direct(p_user uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare c uuid;
begin
 if not kapani_private.active() or p_user=auth.uid() or not exists(select 1 from public.profiles where id=p_user and not blocked) then raise exception 'Access denied'; end if;
 perform pg_advisory_xact_lock(hashtextextended(least(auth.uid()::text,p_user::text)||greatest(auth.uid()::text,p_user::text),0));
 select x.id into c from public.conversations x join public.conversation_members a on a.conversation_id=x.id join public.conversation_members b on b.conversation_id=x.id where x.kind='direct' and a.user_id=auth.uid() and b.user_id=p_user limit 1;
 if c is null then insert into public.conversations(kind) values('direct') returning id into c; insert into public.conversation_members values(c,auth.uid(),null,false),(c,p_user,null,false); end if;
 return c;
end $$;
create function public.send_message(p_id uuid,p_conversation uuid,p_body text) returns public.messages language plpgsql security definer set search_path='' as $$
declare m public.messages;
begin
 if not kapani_private.member(p_conversation) then raise exception 'Access denied'; end if;
 if p_body is null or length(trim(p_body))=0 then raise exception 'Empty message'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,1));
 select * into m from public.messages where id=p_id;
 if m.id is not null then if m.author_id<>auth.uid() or m.conversation_id<>p_conversation or m.body<>p_body then raise exception 'Idempotency conflict'; end if; return m; end if;
 if (select count(*) from public.messages where author_id=auth.uid() and created_at>now()-interval '1 minute')>=40 then raise exception 'Rate limit'; end if;
 insert into public.messages(id,conversation_id,author_id,body) values(p_id,p_conversation,auth.uid(),p_body) returning * into m;
 return m;
end $$;
insert into public.conversations(kind,title) values('public','Общий чат Капани');
-- No broad table writes. Administrative/financial mutations must go through audited RPC.
do $$ declare t text; begin foreach t in array array['profiles','roles','permissions','role_permissions','user_roles','audit_log','notifications','accounts','transactions','entries','conversations','conversation_members','messages','posts','post_comments','post_reactions'] loop execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon, authenticated',t); execute format('grant select on public.%I to authenticated',t); end loop; end $$;
grant usage on schema kapani_private to authenticated;
revoke all on all functions in schema kapani_private from public,anon,authenticated;
grant execute on function kapani_private.active(),kapani_private.member(uuid),kapani_private.mayor() to authenticated;
revoke all on function public.transfer(text,bigint,uuid,text),public.open_direct(uuid),public.send_message(uuid,uuid,text) from public,anon;
grant execute on function public.transfer(text,bigint,uuid,text),public.open_direct(uuid),public.send_message(uuid,uuid,text) to authenticated;
create policy profiles_read on public.profiles for select to authenticated using(kapani_private.active());
grant update(display_name,bio,avatar_path,cover_path,show_online) on public.profiles to authenticated;
create policy profiles_edit on public.profiles for update to authenticated using(id=auth.uid() and kapani_private.active()) with check(id=auth.uid());
create policy roles_read on public.roles for select to authenticated using(kapani_private.active());
create policy user_roles_read on public.user_roles for select to authenticated using(kapani_private.active());
create policy accounts_read on public.accounts for select to authenticated using(owner_id=auth.uid() and kapani_private.active());
create policy entries_read on public.entries for select to authenticated using(exists(select 1 from public.accounts a where a.id=account_id and a.owner_id=auth.uid()));
create policy transactions_read on public.transactions for select to authenticated using(exists(select 1 from public.entries e join public.accounts a on a.id=e.account_id where e.transaction_id=transactions.id and a.owner_id=auth.uid()));
create policy conversations_read on public.conversations for select to authenticated using(kapani_private.member(id));
create policy members_read on public.conversation_members for select to authenticated using(kapani_private.member(conversation_id));
create policy messages_read on public.messages for select to authenticated using(kapani_private.member(conversation_id));
create policy notification_read on public.notifications for select to authenticated using(user_id=auth.uid() and kapani_private.active());
grant update(read_at) on public.notifications to authenticated;
create policy notification_update on public.notifications for update to authenticated using(user_id=auth.uid() and kapani_private.active()) with check(user_id=auth.uid());
create policy audit_read on public.audit_log for select to authenticated using(kapani_private.mayor());
grant insert,delete on public.posts to authenticated;
grant update(body,visibility) on public.posts to authenticated;
create policy posts_read on public.posts for select to authenticated using(kapani_private.active() and (visibility='residents' or author_id=auth.uid()));
create policy posts_insert on public.posts for insert to authenticated with check(author_id=auth.uid() and kapani_private.active());
create policy posts_update on public.posts for update to authenticated using(author_id=auth.uid() and kapani_private.active()) with check(author_id=auth.uid());
create policy posts_delete on public.posts for delete to authenticated using(author_id=auth.uid() and kapani_private.active());
commit;
