-- QA-only transaction; fake route is an explicit test fixture, not a routing test.
begin;
do $$begin if exists(select 1 from auth.users where email not like '%@example.invalid') then raise exception 'QA-only database required';end if;end$$;
select set_config('test.passenger',(select id::text from public.profiles where username like 'qa_alice_%'),true);
select set_config('test.driver',(select id::text from public.profiles where username like 'qa_doctor_%'),true);
select set_config('test.other',(select id::text from public.profiles where username like 'qa_bob_%'),true);
do $$begin if current_setting('test.passenger',true) is null or current_setting('test.driver',true) is null then raise exception 'QA fixtures missing';end if;end$$;
insert into public.user_roles(user_id,role) values(current_setting('test.driver')::uuid,'driver') on conflict do nothing;
select kapani_private.issue((select id from public.accounts where owner_id=current_setting('test.passenger')::uuid and kind='wallet'),100000,current_setting('test.passenger')::uuid,'qa_taxi_fixture',now());
select set_config('test.before',(select balance::text from public.accounts where owner_id=current_setting('test.passenger')::uuid and kind='wallet'),true);
select set_config('test.driver_before',(select balance::text from public.accounts where owner_id=current_setting('test.driver')::uuid and kind='wallet'),true);
select set_config('test.quote',(public.store_taxi_quote(current_setting('test.passenger')::uuid,52.6,38.5,52.61,38.51,1200,180,'qa-fixture-not-road-validation','{"type":"LineString","coordinates":[[38.5,52.6],[38.51,52.61]]}')).id::text,true);
select set_config('test.amount',(select amount::text from public.taxi_quotes where id=current_setting('test.quote')::uuid),true);
select set_config('test.driver_amount',(select (amount-commission)::text from public.taxi_quotes where id=current_setting('test.quote')::uuid),true);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.driver'),true);
select public.set_taxi_driver('QA автомобиль','QA TEST',true,true);
select set_config('request.jwt.claim.sub',current_setting('test.passenger'),true);
select set_config('test.ride',public.request_taxi(current_setting('test.quote')::uuid)::text,true);
select public.request_taxi(current_setting('test.quote')::uuid);
do $$begin
 if (select balance from public.accounts where kind='wallet' and owner_id=auth.uid())<>current_setting('test.before')::bigint-current_setting('test.amount')::bigint then raise exception 'Double reserve';end if;
end$$;
select set_config('request.jwt.claim.sub',current_setting('test.other'),true);
do $$begin
 if exists(select 1 from public.taxi_rides where id=current_setting('test.ride')::uuid) or exists(select 1 from public.taxi_quotes where id=current_setting('test.quote')::uuid) then raise exception 'Foreign route leaked';end if;
 begin perform public.taxi_action(current_setting('test.ride')::uuid,'cancel');raise exception 'Unauthorized cancel';exception when others then if sqlerrm<>'Access denied' then raise;end if;end;
 begin perform public.store_taxi_quote(auth.uid(),52.6,38.5,52.61,38.51,1200,180,'forged','{}');raise exception 'Client forged quote';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub',current_setting('test.driver'),true);
select set_config('test.offer',(select id::text from public.taxi_offers where ride_id=current_setting('test.ride')::uuid and status='pending'),true);
select public.respond_taxi_offer(current_setting('test.offer')::uuid,true);
select public.respond_taxi_offer(current_setting('test.offer')::uuid,true);
do $$begin begin perform public.taxi_action(current_setting('test.ride')::uuid,'completed');raise exception 'Skipped states';exception when others then if sqlerrm<>'Invalid transition' then raise;end if;end;end$$;
select public.update_taxi_location(52.6,38.5);
select set_config('request.jwt.claim.sub',current_setting('test.passenger'),true);
do $$begin if not exists(select 1 from public.taxi_driver_info(current_setting('test.ride')::uuid) where latitude=52.6 and longitude=38.5) then raise exception 'Allowed location missing';end if;end$$;
select set_config('request.jwt.claim.sub',current_setting('test.driver'),true);
select public.taxi_action(current_setting('test.ride')::uuid,'arriving');
select public.taxi_action(current_setting('test.ride')::uuid,'waiting');
select public.taxi_action(current_setting('test.ride')::uuid,'in_progress');
select public.taxi_action(current_setting('test.ride')::uuid,'completed');
select public.taxi_action(current_setting('test.ride')::uuid,'completed');
do $$begin
 if (select balance from public.accounts where owner_id=auth.uid() and kind='wallet')<>current_setting('test.driver_before')::bigint+current_setting('test.driver_amount')::bigint then raise exception 'Wrong driver payment';end if;
 if exists(select 1 from public.taxi_drivers where user_id=auth.uid() and latitude is not null) then raise exception 'Location retained';end if;
end$$;
reset role;
-- A new explicit QA quote tests offer timeout and system refund without changing the clock.
select set_config('test.quote',(public.store_taxi_quote(current_setting('test.passenger')::uuid,52.6,38.5,52.61,38.51,1200,180,'qa-fixture-not-road-validation','{"type":"LineString","coordinates":[[38.5,52.6],[38.51,52.61]]}')).id::text,true);
select set_config('test.before',(select balance::text from public.accounts where owner_id=current_setting('test.passenger')::uuid and kind='wallet'),true);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.passenger'),true);
select set_config('test.ride',public.request_taxi(current_setting('test.quote')::uuid)::text,true);
reset role;
update public.taxi_offers set expires_at=now()-interval '1 second' where ride_id=current_setting('test.ride')::uuid and status='pending';
select kapani_private.taxi_tick();
do $$begin if (select status from public.taxi_rides where id=current_setting('test.ride')::uuid)<>'searching' then raise exception 'Offer timeout failed';end if;end$$;
select kapani_private.cancel_taxi(current_setting('test.ride')::uuid,null,'QA системная отмена');
select kapani_private.cancel_taxi(current_setting('test.ride')::uuid,null,'QA повторная системная отмена');
do $$begin
 if (select balance from public.accounts where owner_id=current_setting('test.passenger')::uuid and kind='wallet')<>current_setting('test.before')::bigint then raise exception 'Refund mismatch';end if;
 if exists(select transaction_id from public.entries group by transaction_id having sum(amount)<>0) then raise exception 'Unbalanced ledger';end if;
end$$;
set constraints all immediate;
rollback;
select 'PASS reserve replay, RLS, permissions, offers, transitions, payment replay, location lifecycle, timeout and system refund' as result;
