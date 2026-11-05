-- Read-only assertions with supplied clock values. No production time is changed.
do $$declare b record;begin
 select * into b from kapani_private.task_bounds('daily','2026-01-01Z','2026-11-04T20:59:59Z');
 if b.starts_at<>'2026-11-03T21:00:00Z'::timestamptz or b.ends_at<>'2026-11-04T21:00:00Z'::timestamptz then raise exception 'Before midnight failed';end if;
 select * into b from kapani_private.task_bounds('daily','2026-01-01Z','2026-11-04T21:00:00Z');
 if b.starts_at<>'2026-11-04T21:00:00Z'::timestamptz or b.ends_at<>'2026-11-05T21:00:00Z'::timestamptz then raise exception 'At midnight failed';end if;
 select * into b from kapani_private.task_bounds('weekly','2026-01-01Z','2026-11-08T21:00:00Z');
 if b.starts_at<>'2026-11-08T21:00:00Z'::timestamptz or b.ends_at<>'2026-11-15T21:00:00Z'::timestamptz then raise exception 'Monday boundary failed';end if;
 select * into b from kapani_private.task_bounds('once','2026-11-04T12:00:00Z','2027-01-01Z');
 if b.starts_at<>'2026-11-04T12:00:00Z'::timestamptz or b.ends_at is not null then raise exception 'One-time period failed';end if;
end$$;
select 'PASS four calendar assertions' as result;
