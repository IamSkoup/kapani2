begin;
-- Storage performs its initial INSERT permission probe before metadata exists.
-- Bucket type/size caps remain enforced; send_message_media validates final metadata.
alter policy kapani_upload_insert on storage.objects with check(
 bucket_id in('kapani-chat','kapani-avatars') and (storage.foldername(name))[1]=auth.uid()::text
 and kapani_private.active() and exists(select 1 from public.uploads u where u.bucket=bucket_id and u.path=name and u.owner_id=auth.uid() and u.message_id is null and u.created_at>now()-interval '1 hour'
 and (u.conversation_id is null or kapani_private.member(u.conversation_id)))
);
create or replace function public.mark_conversation_read(p_conversation uuid,p_message uuid) returns void language plpgsql security definer set search_path='' as $$
declare t timestamptz;
begin
 if not kapani_private.member(p_conversation) then raise exception 'Access denied';end if;
 select created_at into t from public.messages where id=p_message and conversation_id=p_conversation;
 if t is null then return;end if;
 insert into public.conversation_members(conversation_id,user_id,read_at) values(p_conversation,auth.uid(),t)
 on conflict(conversation_id,user_id) do update set read_at=greatest(public.conversation_members.read_at,excluded.read_at)
 where public.conversation_members.read_at is null or public.conversation_members.read_at<excluded.read_at;
end $$;
create function public.available_clinic_slots(p_after timestamptz default now()) returns setof public.clinic_slots language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 return query select s.* from public.clinic_slots s where s.starts_at>greatest(p_after,now())
 and exists(select 1 from public.user_roles r join public.profiles p on p.id=r.user_id where r.user_id=s.doctor_id and r.role='doctor' and not p.blocked)
 and not exists(select 1 from public.appointments a where a.slot_id=s.id and a.status in('booked','completed'))
 order by s.starts_at,s.id limit 100;
end $$;
revoke all on function public.available_clinic_slots(timestamptz) from public,anon;
grant execute on function public.available_clinic_slots(timestamptz) to authenticated;
create or replace function public.book_appointment(p_service uuid,p_slot uuid,p_key uuid) returns uuid language plpgsql security definer set search_path='' as $$declare s public.clinic_services;t public.clinic_slots;a public.appointments;esc uuid;w uuid;v uuid;begin
 if not kapani_private.active() or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
 if p_key is null then raise exception 'Key required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,3));
 select * into a from public.appointments where patient_id=auth.uid() and idempotency_key=p_key;
 if a.id is not null then if a.slot_id<>p_slot or a.service_id<>p_service then raise exception 'Idempotency conflict';end if;return a.id;end if;
 select * into t from public.clinic_slots where id=p_slot for update;
 select * into s from public.clinic_services where id=p_service and active;
 if not exists(select 1 from public.user_roles r join public.profiles p on p.id=r.user_id where r.user_id=t.doctor_id and r.role='doctor' and not p.blocked) or t.id is null or s.id is null or t.starts_at<=now() or t.doctor_id<>s.doctor_id or exists(select 1 from public.appointments where slot_id=t.id and status in('booked','completed')) then raise exception 'Slot unavailable';end if;
 insert into public.accounts(kind) values('escrow') returning id into esc;
 select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';
 if s.price>0 then perform kapani_private.move_money(w,esc,s.price,auth.uid(),'clinic_reserve');end if;
 insert into public.appointments(patient_id,slot_id,service_id,price,escrow_id,idempotency_key) values(auth.uid(),t.id,s.id,s.price,esc,p_key) returning id into v;
 insert into public.notifications(user_id,category,title,href) values(t.doctor_id,'clinic','Новая запись на приём','#clinic'),(auth.uid(),'clinic','Запись подтверждена','#clinic');return v;
end $$;
commit;
