begin;
do $$begin if exists(select 1 from auth.users) then raise exception 'Test requires empty staging';end if;end $$;
insert into auth.users(id,raw_user_meta_data) values
('10000000-0000-4000-8000-000000000001','{"username":"test_resident"}'),
('10000000-0000-4000-8000-000000000002','{"username":"test_mayor"}'),
('10000000-0000-4000-8000-000000000003','{"username":"test_doctor"}'),
('10000000-0000-4000-8000-000000000004','{"username":"test_other"}');
insert into public.user_roles(user_id,role) values('10000000-0000-4000-8000-000000000002','mayor'),('10000000-0000-4000-8000-000000000003','doctor');
update public.profiles set verified=true where username<>'test_resident';
update public.accounts set balance=10000 where owner_id in('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004') and kind='wallet';
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
insert into public.applications(id,applicant_id,kind,title,body) values('20000000-0000-4000-8000-000000000001',auth.uid(),'verification','Подтверждение','Тестовое заявление');
do $$begin
 begin perform public.review_application('20000000-0000-4000-8000-000000000001',true,'Одобрено');raise exception 'TEST unauthorized review';exception when others then if sqlerrm<>'Access denied' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select public.review_application('20000000-0000-4000-8000-000000000001',true,'Проверено');
do $$begin if not(select verified from public.profiles where username='test_resident') then raise exception 'TEST verification';end if;end $$;
insert into public.applications(id,applicant_id,kind,title,body) values('20000000-0000-4000-8000-000000000002',auth.uid(),'initiative','Своё заявление','Нельзя одобрить самому');
do $$begin
 begin perform public.review_application('20000000-0000-4000-8000-000000000002',true,'Одобрено');raise exception 'TEST self approval';exception when others then if sqlerrm<>'Self approval prohibited' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
insert into public.applications(id,applicant_id,kind,title,body) values('20000000-0000-4000-8000-000000000003',auth.uid(),'business','Лесная лавка','Тестовый бизнес');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select public.review_application('20000000-0000-4000-8000-000000000003',true,'Согласовано');
do $$begin if not exists(select 1 from public.businesses where name='Лесная лавка') then raise exception 'TEST business creation';end if;end $$;
select public.create_vacancy(null,'Водитель','Тестовая работа',1,500,'driver');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
insert into public.job_applications(vacancy_id,applicant_id,letter) select id,auth.uid(),'Готов работать' from public.vacancies;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select public.review_job((select id from public.job_applications limit 1),true,'Принят');
do $$begin if not exists(select 1 from public.user_roles where user_id='10000000-0000-4000-8000-000000000001' and role='driver') then raise exception 'TEST role grant';end if;end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
select public.create_clinic_service('Тестовый приём',700);
select public.create_clinic_slot(date_trunc('hour',now())+interval '1 day');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select public.book_appointment((select id from public.clinic_services limit 1),(select id from public.clinic_slots limit 1),'30000000-0000-4000-8000-000000000001');
select public.book_appointment((select id from public.clinic_services limit 1),(select id from public.clinic_slots limit 1),'30000000-0000-4000-8000-000000000001');
do $$begin if (select balance from public.accounts where kind='wallet' and owner_id=auth.uid())<>9300 then raise exception 'TEST appointment double charge';end if;end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000004',true);
do $$begin
 if exists(select 1 from public.appointments) then raise exception 'TEST patient privacy';end if;
 begin perform public.book_appointment((select id from public.clinic_services limit 1),(select id from public.clinic_slots limit 1),'30000000-0000-4000-8000-000000000002');raise exception 'TEST double booking';exception when others then if sqlerrm<>'Slot unavailable' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select public.appointment_action((select id from public.appointments limit 1),true);
select public.appointment_action((select id from public.appointments limit 1),true);
do $$begin if (select balance from public.accounts where kind='wallet' and owner_id=auth.uid())<>10000 then raise exception 'TEST appointment refund';end if;end $$;
reset role;
do $$begin if (select sum(balance) from public.accounts)<>20000 then raise exception 'TEST money conservation';end if;end $$;
set constraints all immediate;
set constraints all immediate;
rollback;
