begin;
create table kapani_private.login_rate_buckets(bucket text not null,period timestamptz not null,attempts integer not null check(attempts>0),primary key(bucket,period));
alter table kapani_private.login_rate_buckets enable row level security;
revoke all on kapani_private.login_rate_buckets from public,anon,authenticated;
create function public.prepare_login(p_identifier text,p_account_hash text,p_network_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare slot timestamptz:=date_trunc('hour',now());n integer;m integer;mail text;
begin
 if p_identifier is null or length(p_identifier)>254 or p_account_hash !~ '^[a-f0-9]{64}$' or p_network_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid request';end if;
 insert into kapani_private.login_rate_buckets(bucket,period,attempts) values('account:'||p_account_hash,slot,1) on conflict(bucket,period) do update set attempts=kapani_private.login_rate_buckets.attempts+1 returning attempts into n;
 insert into kapani_private.login_rate_buckets(bucket,period,attempts) values('network:'||p_network_hash,slot,1) on conflict(bucket,period) do update set attempts=kapani_private.login_rate_buckets.attempts+1 returning attempts into m;
 if n>20 or m>100 then return jsonb_build_object('limited',true);end if;
 select u.email into mail from auth.users u join public.profiles p on p.id=u.id where not p.blocked and case when position('@' in p_identifier)>0 then lower(u.email)=lower(trim(p_identifier)) else lower(p.username)=lower(trim(p_identifier)) end limit 1;
 return jsonb_build_object('limited',false,'email',mail);
end$$;
revoke all on function public.prepare_login(text,text,text) from public,anon,authenticated;
grant execute on function public.prepare_login(text,text,text) to service_role;
-- Only pseudonymous counters are expired; user, order and audit history are untouched.
select cron.schedule('kapani-login-counters','20 * * * *',$job$delete from kapani_private.login_rate_buckets where period<now()-interval '48 hours'$job$);
commit;
