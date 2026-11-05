create extension if not exists pg_cron;
select cron.schedule('kapani-daily-economy','5 * * * *',$$select kapani_private.daily_jobs();$$);
