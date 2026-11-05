begin;
create table public.listings(id uuid primary key default gen_random_uuid(),seller_id uuid not null references public.profiles,title text not null check(length(title) between 2 and 160),description text not null default '' check(length(description)<=10000),category text not null default 'Другое',price bigint not null check(price between 1 and 10000000000),stock integer not null check(stock between 0 and 100000),active boolean not null default true,created_at timestamptz not null default now());
create table public.orders(id uuid primary key default gen_random_uuid(),buyer_id uuid not null references public.profiles,seller_id uuid not null references public.profiles,listing_id uuid not null references public.listings,quantity integer not null check(quantity between 1 and 99),total bigint not null check(total>0),escrow_id uuid not null references public.accounts,status text not null default 'reserved' check(status in ('reserved','accepted','completed','cancelled','disputed')),idempotency_key uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(buyer_id,idempotency_key));
create index listings_catalog on public.listings(active,created_at desc);
create index orders_buyer on public.orders(buyer_id,created_at desc);
create index orders_seller on public.orders(seller_id,status);
alter table public.listings enable row level security;
alter table public.orders enable row level security;
revoke all on public.listings,public.orders from anon,authenticated;
grant select on public.listings,public.orders to authenticated;
grant insert on public.listings to authenticated;
grant update(title,description,category,price,stock,active) on public.listings to authenticated;
create policy listings_read on public.listings for select to authenticated using(kapani_private.active() and (active or seller_id=auth.uid()));
create policy listings_insert on public.listings for insert to authenticated with check(seller_id=auth.uid() and exists(select 1 from public.profiles where id=auth.uid() and verified and not blocked));
create policy listings_update on public.listings for update to authenticated using(seller_id=auth.uid() and kapani_private.active()) with check(seller_id=auth.uid());
create policy orders_read on public.orders for select to authenticated using(kapani_private.active() and (buyer_id=auth.uid() or seller_id=auth.uid() or kapani_private.mayor()));
create function kapani_private.move_money(p_from uuid,p_to uuid,p_amount bigint,p_actor uuid,p_kind text) returns uuid language plpgsql security definer set search_path='' as $$ declare tx uuid; begin
 if p_from is null or p_to is null or p_from=p_to or p_amount is null or p_amount<=0 then raise exception 'Invalid payment';end if;
 perform 1 from public.accounts where id in (p_from,p_to) order by id for update;
 if not exists(select 1 from public.accounts where id=p_to) or not exists(select 1 from public.accounts where id=p_from and balance>=p_amount) then raise exception 'Insufficient funds';end if;
 insert into public.transactions(actor,idempotency_key,kind) values(p_actor,gen_random_uuid(),p_kind) returning id into tx;
 insert into public.entries(transaction_id,account_id,amount) values(tx,p_from,-p_amount),(tx,p_to,p_amount);
 update public.accounts set balance=balance-p_amount where id=p_from;
 update public.accounts set balance=balance+p_amount where id=p_to;
 return tx;
end $$;
revoke all on function kapani_private.move_money(uuid,uuid,bigint,uuid,text) from public,anon,authenticated;
create function public.purchase(p_listing uuid,p_quantity integer,p_key uuid) returns uuid language plpgsql security definer set search_path='' as $$ declare l public.listings;o public.orders;esc uuid;wallet uuid;oid uuid;begin
 if not kapani_private.active() or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
 if p_key is null or p_quantity is null or p_quantity not between 1 and 99 then raise exception 'Invalid order';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,2));
 select * into o from public.orders where buyer_id=auth.uid() and idempotency_key=p_key;
 if o.id is not null then if o.listing_id<>p_listing or o.quantity<>p_quantity then raise exception 'Idempotency conflict';end if;return o.id;end if;
 select * into l from public.listings where id=p_listing for update;
 if l.id is null or not l.active or l.stock<p_quantity or l.seller_id=auth.uid() then raise exception 'Item unavailable';end if;
 select id into wallet from public.accounts where owner_id=auth.uid() and kind='wallet';
 insert into public.accounts(kind) values('escrow') returning id into esc;
 perform kapani_private.move_money(wallet,esc,l.price*p_quantity,auth.uid(),'purchase_reserve');
 update public.listings set stock=stock-p_quantity where id=l.id;
 insert into public.orders(buyer_id,seller_id,listing_id,quantity,total,escrow_id,idempotency_key) values(auth.uid(),l.seller_id,l.id,p_quantity,l.price*p_quantity,esc,p_key) returning id into oid;
 insert into public.notifications(user_id,category,title,href) values(l.seller_id,'orders','Новый заказ: требуется подтверждение','#market'),(auth.uid(),'orders','Оплата заказа зарезервирована','#market');
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'purchase',oid);
 return oid;
end $$;
create function public.order_action(p_order uuid,p_action text) returns text language plpgsql security definer set search_path='' as $$ declare o public.orders;wallet uuid;next_status text;begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into o from public.orders where id=p_order for update;
 if o.id is null or auth.uid() not in(o.buyer_id,o.seller_id) then raise exception 'Access denied';end if;
 if p_action='accept' and auth.uid()=o.seller_id then
 if o.status='accepted' then return o.status;end if;
 if o.status<>'reserved' then raise exception 'Invalid transition';end if;next_status:='accepted';
 elsif p_action='receive' and auth.uid()=o.buyer_id then
 if o.status='completed' then return o.status;end if;
 if o.status<>'accepted' then raise exception 'Invalid transition';end if;
 select id into wallet from public.accounts where owner_id=o.seller_id and kind='wallet';
 perform kapani_private.move_money(o.escrow_id,wallet,o.total,auth.uid(),'purchase_settle');next_status:='completed';
 elsif p_action='cancel' then
 if o.status='cancelled' then return o.status;end if;
 if o.status not in('reserved','accepted') then raise exception 'Invalid transition';end if;
 select id into wallet from public.accounts where owner_id=o.buyer_id and kind='wallet';
 perform kapani_private.move_money(o.escrow_id,wallet,o.total,auth.uid(),'purchase_refund');
 update public.listings set stock=stock+o.quantity where id=o.listing_id;next_status:='cancelled';
 elsif p_action='dispute' then
 if o.status='disputed' then return o.status;end if;
 if o.status<>'accepted' then raise exception 'Invalid transition';end if;next_status:='disputed';
 else raise exception 'Access denied';end if;
 update public.orders set status=next_status,updated_at=now() where id=o.id;
 insert into public.notifications(user_id,category,title,body,href) values(o.buyer_id,'orders','Статус заказа изменён',next_status,'#market'),(o.seller_id,'orders','Статус заказа изменён',next_status,'#market');
 insert into public.audit_log(actor,action,entity) values(auth.uid(),'order_'||p_action,o.id);
 return next_status;
end $$;
revoke all on function public.purchase(uuid,integer,uuid),public.order_action(uuid,text) from public,anon;
grant execute on function public.purchase(uuid,integer,uuid),public.order_action(uuid,text) to authenticated;
commit;
