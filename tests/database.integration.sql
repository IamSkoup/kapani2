-- Only in an empty staging Supabase. All fixtures roll back atomically.
begin;
do $$begin if exists(select 1 from auth.users) then raise exception 'Test requires empty staging';end if;end $$;
insert into auth.users(id,raw_user_meta_data) values
('10000000-0000-4000-8000-000000000001','{"username":"test_alice"}'),
('10000000-0000-4000-8000-000000000002','{"username":"test_bob"}'),
('10000000-0000-4000-8000-000000000003','{"username":"test_eve"}');
update public.profiles set verified=true where username like 'test_%';
-- Fixture initialization is not a production emission mechanism.
update public.accounts set balance=10000 where owner_id='10000000-0000-4000-8000-000000000001' and kind='wallet';
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select public.transfer('test_bob',1000,'20000000-0000-4000-8000-000000000001');
select public.transfer('test_bob',1000,'20000000-0000-4000-8000-000000000001');
do $$ begin
 if (select balance from public.accounts where kind='wallet')<>9000 then raise exception 'TEST: debit duplicated'; end if;
 begin perform public.transfer('test_bob',1001,'20000000-0000-4000-8000-000000000001');raise exception 'TEST: conflicting replay accepted';exception when others then if sqlerrm<>'Idempotency conflict' then raise; end if;end;
 begin perform public.transfer('test_bob',9999999,'20000000-0000-4000-8000-000000000002');raise exception 'TEST: overdraft accepted';exception when others then if sqlerrm<>'Insufficient funds' then raise; end if;end;
 begin update public.accounts set balance=999999;raise exception 'TEST: client balance mutation permitted';exception when insufficient_privilege then null;end;
 if exists(select 1 from public.accounts where owner_id<>'10000000-0000-4000-8000-000000000001') then raise exception 'TEST: foreign account exposed'; end if;
end $$;
select public.send_message('30000000-0000-4000-8000-000000000001', public.open_direct('10000000-0000-4000-8000-000000000002'),'private test');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$ begin
 if exists(select 1 from public.messages where id='30000000-0000-4000-8000-000000000001') then raise exception 'TEST: private message leaked';end if;
 begin insert into public.user_roles(user_id,role) values(auth.uid(),'mayor');raise exception 'TEST: privilege escalation';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ begin
 if (select sum(balance) from public.accounts where owner_id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'))<>10000 then raise exception 'TEST: money conservation';end if;
 if (select sum(amount) from public.entries)<>0 then raise exception 'TEST: unbalanced journal';end if;
 if (select count(*) from public.transactions)<>1 then raise exception 'TEST: duplicate transaction';end if;
end $$;
set constraints all immediate;
set constraints all immediate;
rollback;
