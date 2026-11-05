begin;
-- A deferred constraint runs at HTTP transaction commit, after the RPC has
-- restored the caller role. It must see BOTH sides without exposing either.
-- Trigger only: the client cannot execute it or write ledger rows directly.
alter function kapani_private.balance_check() security definer;
revoke all on function kapani_private.balance_check() from public, anon, authenticated;
commit;
