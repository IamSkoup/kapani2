-- Only in an empty staging project. Fixtures are rolled back atomically.
begin;
do $$begin if exists(select 1 from auth.users) then raise exception 'Test requires empty staging';end if;end $$;
insert into auth.users(id,raw_user_meta_data) values('10000000-0000-4000-8000-000000000001','{"username":"test_buyer"}'),('10000000-0000-4000-8000-000000000002','{"username":"test_seller"}'),('10000000-0000-4000-8000-000000000003','{"username":"test_third"}');
update public.profiles set verified=true;
update public.accounts set balance=10000 where owner_id in('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003') and kind='wallet';
insert into public.listings(id,seller_id,title,price,stock) values('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Test product',1500,1);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select public.purchase('40000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000001');
select public.purchase('40000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000001');
do $$begin
 if (select balance from public.accounts where kind='wallet')<>8500 then raise exception 'TEST duplicate debit';end if;
 if (select stock from public.listings limit 1)<>0 then raise exception 'TEST stock reserve';end if;
 begin perform public.order_action((select id from public.orders limit 1),'accept');raise exception 'TEST buyer accepted';exception when others then if sqlerrm<>'Access denied' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
do $$begin
 if exists(select 1 from public.orders) then raise exception 'TEST third party read';end if;
 begin perform public.purchase('40000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000002');raise exception 'TEST oversell';exception when others then if sqlerrm<>'Item unavailable' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select public.order_action((select id from public.orders limit 1),'accept');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select public.order_action((select id from public.orders limit 1),'cancel');
select public.order_action((select id from public.orders limit 1),'cancel');
do $$begin
 if (select balance from public.accounts where kind='wallet')<>10000 then raise exception 'TEST refund';end if;
 if (select stock from public.listings limit 1)<>1 then raise exception 'TEST duplicate restock';end if;
end $$;
select public.purchase('40000000-0000-4000-8000-000000000001',1,'50000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
select public.order_action((select id from public.orders where status='reserved'),'accept');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select public.order_action((select id from public.orders where status='accepted'),'receive');
select public.order_action((select id from public.orders where status='completed'),'receive');
reset role;
do $$begin
 if (select sum(balance) from public.accounts)<>20000 then raise exception 'TEST conservation';end if;
 if (select sum(amount) from public.entries)<>0 then raise exception 'TEST balanced entries';end if;
 if (select balance from public.accounts where owner_id='10000000-0000-4000-8000-000000000002' and kind='wallet')<>1500 then raise exception 'TEST settlement';end if;
 if exists(select 1 from public.accounts where kind='escrow' and balance<>0) then raise exception 'TEST escrow not closed';end if;
end $$;
set constraints all immediate;
set constraints all immediate;
rollback;
