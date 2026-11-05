begin;
create table public.exams(id uuid primary key,title text not null check(length(title) between 3 and 160),duration_seconds integer not null check(duration_seconds between 60 and 7200),question_count integer not null check(question_count between 1 and 100),pass_percent integer not null check(pass_percent between 1 and 100),fee bigint not null default 0 check(fee between 0 and 10000000),active boolean not null default false,created_at timestamptz not null default now());
create table kapani_private.exam_questions(id uuid primary key,exam_id uuid not null references public.exams,prompt text not null check(length(prompt) between 3 and 4000),explanation text not null default '',active boolean not null default true,created_at timestamptz not null default now());
create table kapani_private.exam_options(id uuid primary key default gen_random_uuid(),question_id uuid not null references kapani_private.exam_questions,body text not null check(length(body) between 1 and 1000),correct boolean not null default false,position integer not null,unique(question_id,position));
create unique index exam_one_correct on kapani_private.exam_options(question_id) where correct;
create table public.exam_attempts(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles,exam_id uuid not null references public.exams,started_at timestamptz not null default now(),deadline timestamptz not null,finished_at timestamptz,question_count integer not null,pass_percent integer not null,score integer,passed boolean,status text not null default 'running' check(status in('running','finished')),idempotency_key uuid not null,unique(user_id,idempotency_key));
create index exam_attempts_user on public.exam_attempts(user_id,started_at desc);
create unique index exam_running_one on public.exam_attempts(user_id,exam_id) where status='running';
create table kapani_private.exam_items(attempt_id uuid references public.exam_attempts,question_id uuid,position integer not null,prompt text not null,options jsonb not null,correct_id uuid not null,explanation text not null,primary key(attempt_id,question_id));
create table public.exam_answers(attempt_id uuid references public.exam_attempts,question_id uuid,option_id uuid not null,answered_at timestamptz not null default now(),primary key(attempt_id,question_id),foreign key(attempt_id,question_id) references kapani_private.exam_items);
create table public.exam_adjustments(id uuid primary key default gen_random_uuid(),attempt_id uuid not null references public.exam_attempts,actor uuid not null references public.profiles,score integer not null,reason text not null check(length(reason) between 10 and 2000),created_at timestamptz not null default now());
create trigger exam_adjustments_immutable before update or delete on public.exam_adjustments for each row execute function kapani_private.immutable();
do $$declare t text;begin foreach t in array array['exams','exam_attempts','exam_answers','exam_adjustments'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);end loop;foreach t in array array['exam_questions','exam_options','exam_items'] loop execute format('alter table kapani_private.%I enable row level security',t);execute format('revoke all on kapani_private.%I from public,anon,authenticated',t);end loop;end $$;
create policy exams_read on public.exams for select to authenticated using(kapani_private.active() and (active or kapani_private.mayor()));
create policy exam_attempts_read on public.exam_attempts for select to authenticated using(kapani_private.active() and (user_id=auth.uid() or kapani_private.mayor()));
create policy exam_answers_read on public.exam_answers for select to authenticated using(exists(select 1 from public.exam_attempts a where a.id=attempt_id and a.user_id=auth.uid() and kapani_private.active()));
create policy exam_adjustments_read on public.exam_adjustments for select to authenticated using(exists(select 1 from public.exam_attempts a where a.id=attempt_id and (a.user_id=auth.uid() or kapani_private.mayor()) and kapani_private.active()));
create function public.save_exam(p_id uuid,p_title text,p_seconds integer,p_questions integer,p_pass integer,p_fee bigint,p_active boolean) returns uuid language plpgsql security definer set search_path='' as $$
begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 if p_active and (select count(*) from kapani_private.exam_questions q where q.exam_id=p_id and q.active and exists(select 1 from kapani_private.exam_options o where o.question_id=q.id and o.correct))<p_questions then raise exception 'Not enough questions';end if;
 insert into public.exams(id,title,duration_seconds,question_count,pass_percent,fee,active) values(p_id,p_title,p_seconds,p_questions,p_pass,p_fee,p_active)
 on conflict(id) do update set title=excluded.title,duration_seconds=excluded.duration_seconds,question_count=excluded.question_count,pass_percent=excluded.pass_percent,fee=excluded.fee,active=excluded.active;
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'exam.configure',p_id,jsonb_build_object('active',p_active,'fee',p_fee));return p_id;
end $$;
create function public.add_exam_question(p_id uuid,p_exam uuid,p_prompt text,p_options text[],p_correct integer,p_explanation text default '') returns uuid language plpgsql security definer set search_path='' as $$
declare i integer;
begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 if p_options is null or cardinality(p_options) not between 2 and 8 or p_correct is null or p_correct not between 1 and cardinality(p_options) then raise exception 'Invalid options';end if;
 if exists(select 1 from kapani_private.exam_questions where id=p_id) then raise exception 'Question already exists';end if;
 insert into kapani_private.exam_questions(id,exam_id,prompt,explanation) values(p_id,p_exam,p_prompt,p_explanation);
 for i in 1..cardinality(p_options) loop insert into kapani_private.exam_options(question_id,body,correct,position) values(p_id,p_options[i],i=p_correct,i);end loop;
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'exam.question.add',p_id);return p_id;
end $$;
create function kapani_private.finish_exam(p_id uuid) returns public.exam_attempts language plpgsql security definer set search_path='' as $$
declare a public.exam_attempts;n integer;
begin
 select * into a from public.exam_attempts where id=p_id for update;
 if a.status='finished' then return a;end if;
 select count(*) into n from kapani_private.exam_items i join public.exam_answers r on r.attempt_id=i.attempt_id and r.question_id=i.question_id and r.option_id=i.correct_id where i.attempt_id=a.id;
 update public.exam_attempts set score=n,passed=n*100>=question_count*pass_percent,status='finished',finished_at=now() where id=a.id returning * into a;
 insert into public.notifications(user_id,category,title,body,href) values(a.user_id,'education','Результат экзамена готов',n::text||' из '||a.question_count::text,'#education');
 insert into public.audit_log(actor,action,entity,details) values(a.user_id,'exam.finish',a.id,jsonb_build_object('score',n,'total',a.question_count));return a;
end $$;
create function public.start_exam(p_exam uuid,p_key uuid) returns public.exam_attempts language plpgsql security definer set search_path='' as $$
declare e public.exams;a public.exam_attempts;q kapani_private.exam_questions;idx integer:=0;w uuid;treasury uuid;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 if p_key is null then raise exception 'Idempotency key required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,11));
 select * into a from public.exam_attempts where user_id=auth.uid() and idempotency_key=p_key;
 if found then if a.exam_id<>p_exam then raise exception 'Idempotency conflict';end if;return a;end if;
 select * into a from public.exam_attempts where user_id=auth.uid() and exam_id=p_exam and status='running';
 if found then if a.deadline>now() then return a;else perform kapani_private.finish_exam(a.id);end if;end if;
 if (select count(*) from public.exam_attempts where user_id=auth.uid() and started_at>now()-interval '1 day')>=3 then raise exception 'Exam attempt limit';end if;
 select * into e from public.exams where id=p_exam and active for share;
 if not found then raise exception 'Exam unavailable';end if;
 insert into public.exam_attempts(user_id,exam_id,deadline,question_count,pass_percent,idempotency_key) values(auth.uid(),e.id,now()+make_interval(secs=>e.duration_seconds),e.question_count,e.pass_percent,p_key) returning * into a;
 for q in select * from kapani_private.exam_questions where exam_id=e.id and active order by random() limit e.question_count loop
 idx:=idx+1;
 insert into kapani_private.exam_items(attempt_id,question_id,position,prompt,options,correct_id,explanation)
 select a.id,q.id,idx,q.prompt,jsonb_agg(jsonb_build_object('id',o.id,'body',o.body) order by o.position),(select id from kapani_private.exam_options where question_id=q.id and correct),q.explanation from kapani_private.exam_options o where o.question_id=q.id;
 end loop;
 if idx<>e.question_count then raise exception 'Not enough questions';end if;
 if e.fee>0 then
  if not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
  select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';select id into treasury from public.accounts where kind='treasury';
  perform kapani_private.move_money(w,treasury,e.fee,auth.uid(),'exam_fee');
 end if;
 return a;
end $$;
create function public.exam_questions(p_attempt uuid) returns table(question_id uuid,"position" integer,prompt text,options jsonb) language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.active() or not exists(select 1 from public.exam_attempts where id=p_attempt and user_id=auth.uid()) then raise exception 'Access denied';end if;
 return query select i.question_id,i.position,i.prompt,i.options from kapani_private.exam_items i where i.attempt_id=p_attempt order by i.position;
end $$;
create function public.answer_exam(p_attempt uuid,p_question uuid,p_option uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.exam_attempts;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into a from public.exam_attempts where id=p_attempt and user_id=auth.uid() for update;
 if not found or a.status<>'running' or a.deadline<=now() then raise exception 'Attempt closed';end if;
 if not exists(select 1 from kapani_private.exam_items i,jsonb_array_elements(i.options)o where i.attempt_id=p_attempt and i.question_id=p_question and o->>'id'=p_option::text) then raise exception 'Invalid answer';end if;
 insert into public.exam_answers(attempt_id,question_id,option_id) values(p_attempt,p_question,p_option)
 on conflict(attempt_id,question_id) do update set option_id=excluded.option_id,answered_at=now();
end $$;
create function public.submit_exam(p_attempt uuid) returns public.exam_attempts language plpgsql security definer set search_path='' as $$
begin
 if not kapani_private.active() or not exists(select 1 from public.exam_attempts where id=p_attempt and user_id=auth.uid()) then raise exception 'Access denied';end if;
 return kapani_private.finish_exam(p_attempt);
end $$;
create function public.exam_result(p_attempt uuid) returns table(question_id uuid,prompt text,selected_id uuid,correct_id uuid,explanation text) language plpgsql stable security definer set search_path='' as $$
begin
 if not kapani_private.active() or not exists(select 1 from public.exam_attempts where id=p_attempt and status='finished' and (user_id=auth.uid() or kapani_private.mayor())) then raise exception 'Access denied';end if;
 return query select i.question_id,i.prompt,a.option_id,i.correct_id,i.explanation from kapani_private.exam_items i left join public.exam_answers a on a.attempt_id=i.attempt_id and a.question_id=i.question_id where i.attempt_id=p_attempt order by i.position;
end $$;
create function public.correct_exam_result(p_attempt uuid,p_score integer,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare a public.exam_attempts;
begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 select * into a from public.exam_attempts where id=p_attempt for update;
 if not found or a.user_id=auth.uid() or a.status<>'finished' or p_score is null or p_score<0 or p_score>a.question_count then raise exception 'Access denied';end if;
 insert into public.exam_adjustments(attempt_id,actor,score,reason) values(a.id,auth.uid(),p_score,p_reason);
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'exam.adjust',a.id,jsonb_build_object('score',p_score,'reason',p_reason));
 insert into public.notifications(user_id,category,title,body,href) values(a.user_id,'education','Результат экзамена скорректирован',p_reason,'#education');
end $$;
create function kapani_private.expire_exams() returns void language plpgsql security definer set search_path='' as $$
declare a record;
begin for a in select id from public.exam_attempts where status='running' and deadline<=now() for update skip locked loop perform kapani_private.finish_exam(a.id);end loop;end $$;
revoke all on function kapani_private.finish_exam(uuid),kapani_private.expire_exams() from public,anon,authenticated;
revoke all on function public.save_exam(uuid,text,integer,integer,integer,bigint,boolean),public.add_exam_question(uuid,uuid,text,text[],integer,text),public.start_exam(uuid,uuid),public.exam_questions(uuid),public.answer_exam(uuid,uuid,uuid),public.submit_exam(uuid),public.exam_result(uuid),public.correct_exam_result(uuid,integer,text) from public,anon;
grant execute on function public.save_exam(uuid,text,integer,integer,integer,bigint,boolean),public.add_exam_question(uuid,uuid,text,text[],integer,text),public.start_exam(uuid,uuid),public.exam_questions(uuid),public.answer_exam(uuid,uuid,uuid),public.submit_exam(uuid),public.exam_result(uuid),public.correct_exam_result(uuid,integer,text) to authenticated;
select cron.schedule('kapani-exam-timeouts','* * * * *',$cron$select kapani_private.expire_exams();$cron$);
commit;
