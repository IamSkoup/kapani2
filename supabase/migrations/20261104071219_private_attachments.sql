begin;
create table public.uploads (
 id uuid primary key, owner_id uuid not null references public.profiles,
 conversation_id uuid references public.conversations,
 message_id uuid references public.messages, bucket text not null check(bucket in('kapani-chat','kapani-avatars')),
 path text not null unique, filename text not null check(length(filename) between 1 and 160),
 mime text not null, byte_size bigint not null check(byte_size between 1 and 20971520),
 created_at timestamptz not null default now(),
 check((bucket='kapani-chat' and conversation_id is not null) or (bucket='kapani-avatars' and conversation_id is null and message_id is null))
);
create index uploads_message on public.uploads(message_id);
create index uploads_owner_time on public.uploads(owner_id,created_at desc);
alter table public.uploads enable row level security;
revoke all on public.uploads from public, anon, authenticated;
grant select on public.uploads to authenticated;
create policy uploads_read on public.uploads for select to authenticated using(
 kapani_private.active() and (owner_id=auth.uid() or (message_id is not null and kapani_private.member(conversation_id) and exists(select 1 from public.messages m where m.id=message_id and m.deleted_at is null)))
);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('kapani-chat','kapani-chat',false,20971520,array['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/webm','audio/ogg','audio/mpeg','application/pdf','text/plain']),
 ('kapani-avatars','kapani-avatars',true,5242880,array['image/jpeg','image/png','image/webp']);
-- Reservations bind immutable path, type, size and owner. No object UPDATE,
-- so a sent attachment cannot be replaced with different bytes later.
create policy kapani_upload_insert on storage.objects for insert to authenticated with check(
 kapani_private.active() and exists(select 1 from public.uploads u where u.bucket=bucket_id and u.path=name and u.owner_id=auth.uid() and u.message_id is null and u.created_at>now()-interval '1 hour'
 and u.mime=metadata->>'mimetype' and u.byte_size=(metadata->>'size')::bigint)
);
create policy kapani_upload_read on storage.objects for select to authenticated using(
 bucket_id in('kapani-chat','kapani-avatars') and kapani_private.active()
 and exists(select 1 from public.uploads u where u.bucket=bucket_id and u.path=name
 and (u.owner_id=auth.uid() or (u.bucket='kapani-chat' and u.message_id is not null
 and kapani_private.member(u.conversation_id)
 and exists(select 1 from public.messages m where m.id=u.message_id and m.conversation_id=u.conversation_id and m.deleted_at is null))))
);
create function public.reserve_upload(p_id uuid,p_conversation uuid,p_filename text,p_mime text,p_size bigint) returns public.uploads language plpgsql security definer set search_path='' as $$
declare u public.uploads; ext text; b text;
begin
 if not kapani_private.active() or (p_conversation is not null and not kapani_private.member(p_conversation)) then raise exception 'Access denied'; end if;
 if p_id is null or p_filename is null or length(p_filename) not between 1 and 160 or p_filename ~ '[[:cntrl:]/\\]' or p_mime is null or p_size is null or p_size<1 then raise exception 'Invalid file'; end if;
 b:=case when p_conversation is null then 'kapani-avatars' else 'kapani-chat' end;
 ext:=lower(substring(p_filename from '\.([^.]+)$'));
 if ext is null or not ((p_mime='image/jpeg' and ext in('jpg','jpeg')) or (p_mime='image/png' and ext='png') or (p_mime='image/webp' and ext='webp') or (p_conversation is not null and ((p_mime='video/mp4' and ext='mp4') or (p_mime in('video/webm','audio/webm') and ext='webm') or (p_mime='audio/ogg' and ext='ogg') or (p_mime='audio/mpeg' and ext='mp3') or (p_mime='application/pdf' and ext='pdf') or (p_mime='text/plain' and ext='txt')))) then raise exception 'Unsupported file'; end if;
 if p_size>(case when p_conversation is null then 5242880 else 20971520 end) then raise exception 'File too large'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,5));
 select * into u from public.uploads where id=p_id;
 if found then
   if u.owner_id<>auth.uid() or u.conversation_id is distinct from p_conversation or u.filename<>p_filename or u.mime<>p_mime or u.byte_size<>p_size then raise exception 'Idempotency conflict'; end if;
   return u;
 end if;
 if (select count(*) from public.uploads where owner_id=auth.uid() and created_at>now()-interval '1 hour')>=60 then raise exception 'Rate limit'; end if;
 insert into public.uploads(id,owner_id,conversation_id,bucket,path,filename,mime,byte_size)
 values(p_id,auth.uid(),p_conversation,b,auth.uid()::text||'/'||p_id::text||'.'||ext,p_filename,p_mime,p_size) returning * into u;
 return u;
end $$;
alter table public.messages drop constraint messages_body_check;
alter table public.messages add constraint messages_body_check check(length(body)<=12000);
create function public.send_message_media(p_id uuid,p_conversation uuid,p_body text,p_uploads uuid[] default '{}',p_reply uuid default null) returns public.messages language plpgsql security definer set search_path='' as $$
declare m public.messages; f uuid; old_files uuid[];
begin
 if not kapani_private.member(p_conversation) then raise exception 'Access denied'; end if;
 if p_id is null or p_body is null or p_uploads is null or cardinality(p_uploads)>8 or (length(trim(p_body))=0 and cardinality(p_uploads)=0) then raise exception 'Invalid message'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,1));
 select * into m from public.messages where id=p_id;
 if found then
   select coalesce(array_agg(id order by id),'{}') into old_files from public.uploads where message_id=m.id;
   if m.author_id<>auth.uid() or m.conversation_id<>p_conversation or m.body<>p_body or m.reply_to is distinct from p_reply or old_files<>array(select x from unnest(p_uploads)x order by x) then raise exception 'Idempotency conflict'; end if;
   return m;
 end if;
 if p_reply is not null and not exists(select 1 from public.messages where id=p_reply and conversation_id=p_conversation and deleted_at is null) then raise exception 'Invalid reply'; end if;
 if (select count(*) from public.messages where author_id=auth.uid() and created_at>now()-interval '1 minute')>=40 then raise exception 'Rate limit'; end if;
 perform 1 from public.uploads where id=any(p_uploads) order by id for update;
 if cardinality(p_uploads)<>(select count(*) from public.uploads u join storage.objects o on o.bucket_id=u.bucket and o.name=u.path where u.id=any(p_uploads) and u.owner_id=auth.uid() and u.conversation_id=p_conversation and u.message_id is null and u.byte_size=(o.metadata->>'size')::bigint and u.mime=o.metadata->>'mimetype') then raise exception 'File not uploaded'; end if;
 insert into public.messages(id,conversation_id,author_id,body,reply_to) values(p_id,p_conversation,auth.uid(),p_body,p_reply) returning * into m;
 update public.uploads set message_id=m.id where id=any(p_uploads);
 return m;
end $$;
create function public.set_avatar(p_upload uuid) returns void language plpgsql security definer set search_path='' as $$
declare u public.uploads;
begin
 if not kapani_private.active() then raise exception 'Access denied'; end if;
 select * into u from public.uploads where id=p_upload and owner_id=auth.uid() and bucket='kapani-avatars';
 if not found or not exists(select 1 from storage.objects where bucket_id=u.bucket and name=u.path) then raise exception 'File not uploaded'; end if;
 update public.profiles set avatar_path=u.path where id=auth.uid();
end $$;
-- Avatars are deliberately public; the UI explains this before upload.
revoke update(avatar_path) on public.profiles from authenticated;
revoke all on function public.reserve_upload(uuid,uuid,text,text,bigint),public.send_message_media(uuid,uuid,text,uuid[],uuid),public.set_avatar(uuid) from public,anon;
grant execute on function public.reserve_upload(uuid,uuid,text,text,bigint),public.send_message_media(uuid,uuid,text,uuid[],uuid),public.set_avatar(uuid) to authenticated;
commit;
