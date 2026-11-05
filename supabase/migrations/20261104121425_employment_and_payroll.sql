begin;
create table public.business_funding(id uuid primary key default gen_random_uuid(),business_id uuid not null references public.businesses,actor uuid not null references public.profiles,amount bigint not null check(amount>0),transaction_id uuid not null unique references public.transactions,idempotency_key uuid not null,created_at timestamptz not null default now(),unique(actor,idempotency_key));
create table public.payroll_payments(id uuid primary key default gen_random_uuid(),business_id uuid not null references public.businesses,user_id uuid not null references public.profiles,period date not null check(extract(day from period)=1),amount bigint not null check(amount>0),actor uuid not null references public.profiles,transaction_id uuid not null unique references public.transactions,created_at timestamptz not null default now(),unique(business_id,user_id,period));
create table public.employment_changes(id uuid primary key default gen_random_uuid(),application_id uuid not null references public.job_applications,actor uuid not null references public.profiles,action text not null check(action in('resign','dismiss','withdraw')),reason text not null check(length(reason) between 3 and 2000),created_at timestamptz not null default now());
do $$declare t text;begin foreach t in array array['business_funding','payroll_payments','employment_changes'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('create trigger immutable_%I before update or delete on public.%I for each row execute function kapani_private.immutable()',t,t);end loop;end $$;
create policy funding_read on public.business_funding for select to authenticated using(kapani_private.active() and (actor=auth.uid() or exists(select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()) or kapani_private.mayor()));
create policy payroll_read on public.payroll_payments for select to authenticated using(kapani_private.active() and (user_id=auth.uid() or exists(select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()) or kapani_private.mayor()));
create policy employment_changes_read on public.employment_changes for select to authenticated using(kapani_private.active() and exists(select 1 from public.job_applications j where j.id=application_id));
create function public.fund_business(p_business uuid,p_amount bigint,p_key uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.businesses;prev public.business_funding;w uuid;tx uuid;v uuid;
begin
 if not kapani_private.active() or p_key is null or p_amount is null or p_amount<=0 or p_amount>10000000000 then raise exception 'Access denied';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,12));
 select * into prev from public.business_funding where actor=auth.uid() and idempotency_key=p_key;
 if found then if prev.business_id<>p_business or prev.amount<>p_amount then raise exception 'Idempotency conflict';end if;return prev.id;end if;
 select * into b from public.businesses where id=p_business and owner_id=auth.uid() and status='active' for update;
 if not found or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Access denied';end if;
 select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';
 tx:=kapani_private.move_money(w,b.account_id,p_amount,auth.uid(),'business_funding');
 insert into public.business_funding(business_id,actor,amount,transaction_id,idempotency_key) values(b.id,auth.uid(),p_amount,tx,p_key) returning id into v;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'business.fund',b.id,jsonb_build_object('transaction',tx,'amount',p_amount));return v;
end $$;
create function public.pay_business_salary(p_business uuid,p_user uuid,p_period date default (date_trunc('month',now() at time zone 'Europe/Moscow'))::date) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.businesses;m public.business_members;old public.payroll_payments;w uuid;tx uuid;v uuid;
begin
 if not kapani_private.active() or p_period is null then raise exception 'Access denied';end if;
 select * into b from public.businesses where id=p_business and owner_id=auth.uid() and status='active' for update;
 if not found then raise exception 'Access denied';end if;
 select * into old from public.payroll_payments where business_id=p_business and user_id=p_user and period=p_period;
 if found then return old.id;end if;
 select * into m from public.business_members where business_id=p_business and user_id=p_user and active for update;
 if not found or m.salary<=0 or p_user=auth.uid() then raise exception 'Employee unavailable';end if;
 -- The contract currently uses a fixed calendar-month payment, without proration.
 -- Past back-pay is not silently recalculated at a newly changed salary.
 if p_period<>(date_trunc('month',now() at time zone 'Europe/Moscow'))::date then raise exception 'Only current payroll period';end if;
 if not exists(select 1 from public.profiles where id=p_user and not blocked) then raise exception 'Employee unavailable';end if;
 select id into w from public.accounts where owner_id=p_user and kind='wallet';
 tx:=kapani_private.move_money(b.account_id,w,m.salary,auth.uid(),'business_salary');
 insert into public.payroll_payments(business_id,user_id,period,amount,actor,transaction_id) values(b.id,p_user,p_period,m.salary,auth.uid(),tx) returning id into v;
 insert into public.notifications(user_id,category,title,body,href) values(p_user,'finance','Зарплата зачислена',b.name||' · '||p_period::text,'#bank');
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'business.payroll',b.id,jsonb_build_object('user',p_user,'period',p_period,'transaction',tx));return v;
end $$;
create function public.configure_employee(p_business uuid,p_user uuid,p_position text,p_salary bigint,p_orders boolean,p_catalog boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not kapani_private.active() or not exists(select 1 from public.businesses where id=p_business and owner_id=auth.uid() and status='active') then raise exception 'Access denied';end if;
 if p_salary is null or p_salary<0 or p_salary>10000000000 or p_position is null or length(p_position) not between 2 and 160 or p_reason is null or length(p_reason)<3 then raise exception 'Invalid contract';end if;
 update public.business_members set position=p_position,salary=p_salary,can_manage_orders=p_orders,can_manage_catalog=p_catalog where business_id=p_business and user_id=p_user and active;
 if not found then raise exception 'Employee unavailable';end if;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'business.employee.configure',p_business,jsonb_build_object('user',p_user,'salary',p_salary,'position',p_position,'orders',p_orders,'catalog',p_catalog,'reason',p_reason));
 insert into public.notifications(user_id,category,title,body,href) values(p_user,'work','Условия работы обновлены',p_reason,'#jobs');
end $$;
create function public.end_employment(p_application uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare j public.job_applications;v public.vacancies;own boolean;act text;
begin
 if not kapani_private.active() or p_reason is null or length(p_reason) not between 3 and 2000 then raise exception 'Access denied';end if;
 select * into j from public.job_applications where id=p_application for update;
 if not found then raise exception 'Application unavailable';end if;
 select * into v from public.vacancies where id=j.vacancy_id for update;
 own:=j.applicant_id=auth.uid();
 if not own and not ((v.business_id is null and kapani_private.mayor()) or exists(select 1 from public.businesses where id=v.business_id and owner_id=auth.uid())) then raise exception 'Access denied';end if;
 if j.status in('ended','withdrawn') then return;end if;
 if j.status='pending' and own then act:='withdraw';update public.job_applications set status='withdrawn',resolved_at=now() where id=j.id;
 elsif j.status='accepted' then
  act:=case when own then 'resign' else 'dismiss' end;
  update public.job_applications set status='ended',resolved_at=now() where id=j.id;
  if v.business_id is not null then
   if not exists(select 1 from public.job_applications a join public.vacancies x on x.id=a.vacancy_id where a.applicant_id=j.applicant_id and a.status='accepted' and x.business_id=v.business_id) then update public.business_members set active=false,can_manage_orders=false,can_manage_catalog=false where business_id=v.business_id and user_id=j.applicant_id;end if;
  elsif v.role_code is not null and not exists(select 1 from public.job_applications a join public.vacancies x on x.id=a.vacancy_id where a.applicant_id=j.applicant_id and a.status='accepted' and x.role_code=v.role_code) then
   delete from public.user_roles where user_id=j.applicant_id and role=v.role_code;
  end if;
 else raise exception 'Invalid transition';end if;
 insert into public.employment_changes(application_id,actor,action,reason) values(j.id,auth.uid(),act,p_reason);
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'employment.'||act,j.id,jsonb_build_object('reason',p_reason,'user',j.applicant_id));
 insert into public.notifications(user_id,category,title,body,href) values(j.applicant_id,'work','Статус работы изменён',p_reason,'#jobs');
end $$;
alter table public.vacancies add column required_exam_id uuid references public.exams;
create function public.vacancy_exam_requirement(p_vacancy uuid,p_exam uuid) returns void language plpgsql security definer set search_path='' as $$
declare v public.vacancies;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into v from public.vacancies where id=p_vacancy for update;
 if not found or not ((v.business_id is null and kapani_private.mayor()) or exists(select 1 from public.businesses where id=v.business_id and owner_id=auth.uid())) then raise exception 'Access denied';end if;
 update public.vacancies set required_exam_id=p_exam where id=p_vacancy;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'vacancy.exam',p_vacancy,jsonb_build_object('exam',p_exam));
end $$;
revoke all on function public.fund_business(uuid,bigint,uuid),public.pay_business_salary(uuid,uuid,date),public.configure_employee(uuid,uuid,text,bigint,boolean,boolean,text),public.end_employment(uuid,text),public.vacancy_exam_requirement(uuid,uuid) from public,anon;
grant execute on function public.fund_business(uuid,bigint,uuid),public.pay_business_salary(uuid,uuid,date),public.configure_employee(uuid,uuid,text,bigint,boolean,boolean,text),public.end_employment(uuid,text),public.vacancy_exam_requirement(uuid,uuid) to authenticated;
create or replace function public.review_job(p_id uuid,p_accept boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$declare j public.job_applications;v public.vacancies;begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into j from public.job_applications where id=p_id for update;
 select * into v from public.vacancies where id=j.vacancy_id for update;
 if j.id is null or j.applicant_id=auth.uid() then raise exception 'Self approval prohibited';end if;
 if (v.business_id is null and not kapani_private.mayor()) or (v.business_id is not null and not exists(select 1 from public.businesses where id=v.business_id and owner_id=auth.uid() and status='active')) then raise exception 'Access denied';end if;
 if j.status<>'pending' or not v.active then raise exception 'Invalid transition';end if;
 if p_accept is null or p_reason is null or length(trim(p_reason))<3 then raise exception 'Reason required';end if;
 if p_accept then
 if v.required_exam_id is not null and not exists(select 1 from public.exam_attempts a where a.user_id=j.applicant_id and a.exam_id=v.required_exam_id and a.status='finished'
 and coalesce((select x.score from public.exam_adjustments x where x.attempt_id=a.id order by x.created_at desc,x.id desc limit 1),a.score)*100>=a.question_count*a.pass_percent) then raise exception 'Exam requirement not met';end if;
 if v.business_id is not null and exists(select 1 from public.business_members where business_id=v.business_id and user_id=j.applicant_id and active) then raise exception 'Employee already hired';end if;
 if not exists(select 1 from public.profiles where id=j.applicant_id and verified and not blocked) then raise exception 'Applicant not verified';end if;
 if (select count(*) from public.job_applications where vacancy_id=v.id and status='accepted')>=v.positions then raise exception 'Vacancy full';end if;
 if v.business_id is not null then insert into public.business_members(business_id,user_id,position,salary) values(v.business_id,j.applicant_id,v.title,v.salary) on conflict(business_id,user_id) do update set position=excluded.position,salary=excluded.salary,active=true;
 elsif v.role_code is not null then insert into public.user_roles(user_id,role,assigned_by) values(j.applicant_id,v.role_code,auth.uid()) on conflict do nothing;end if;
 end if;
 update public.job_applications set status=case when p_accept then 'accepted' else 'rejected' end,reviewer_id=auth.uid(),decision=p_reason,resolved_at=now() where id=p_id;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'job_review',p_id,jsonb_build_object('accepted',p_accept,'reason',p_reason));
 insert into public.notifications(user_id,category,title,body,href) values(j.applicant_id,'work','Ответ работодателя',p_reason,'#jobs');
end $$;
commit;
