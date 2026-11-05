begin;
create function kapani_private.business_permission(p_business uuid,p_action text) returns boolean language sql stable security definer set search_path='' as $$
 select kapani_private.active() and exists(select 1 from public.businesses b where b.id=p_business and b.status='active' and (b.owner_id=auth.uid() or exists(select 1 from public.business_members m where m.business_id=b.id and m.user_id=auth.uid() and m.active and case p_action when 'catalog' then m.can_manage_catalog when 'orders' then m.can_manage_orders else false end)))
$$;
revoke all on function kapani_private.business_permission(uuid,text) from public,anon;
grant execute on function kapani_private.business_permission(uuid,text) to authenticated;
create table public.business_products(id uuid primary key,business_id uuid not null references public.businesses,title text not null check(length(title) between 2 and 160),description text not null check(length(description)<=5000),price bigint not null check(price between 1 and 100000000),stock integer not null check(stock between 0 and 1000000),active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create index business_products_catalog on public.business_products(business_id,active,created_at desc);
create table public.business_orders(id uuid primary key default gen_random_uuid(),business_id uuid not null references public.businesses,buyer_id uuid not null references public.profiles,total bigint not null check(total>0),escrow_id uuid not null unique references public.accounts,status text not null default 'reserved' check(status in('reserved','accepted','ready','completed','cancelled','disputed')),comment text not null check(length(comment)<=2000),idempotency_key uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(buyer_id,idempotency_key));
create index business_orders_buyer on public.business_orders(buyer_id,created_at desc);
create index business_orders_queue on public.business_orders(business_id,status,created_at desc);
create table public.business_order_items(order_id uuid references public.business_orders,product_id uuid references public.business_products,title text not null,unit_price bigint not null check(unit_price>0),quantity integer not null check(quantity between 1 and 99),primary key(order_id,product_id));
create table public.business_order_history(id bigint generated always as identity primary key,order_id uuid not null references public.business_orders,actor uuid references public.profiles,status text not null,reason text not null default '',transaction_id uuid references public.transactions,created_at timestamptz not null default now());
create index business_order_history_order on public.business_order_history(order_id,id);
create table public.market_dispute_decisions(order_id uuid primary key references public.orders,actor uuid not null references public.profiles,refund boolean not null,reason text not null check(length(reason) between 10 and 2000),transaction_id uuid not null references public.transactions,created_at timestamptz not null default now());
do $$declare t text;begin foreach t in array array['business_products','business_orders','business_order_items','business_order_history','market_dispute_decisions'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);end loop;end$$;
create policy products_read on public.business_products for select to authenticated using(kapani_private.active() and (active and exists(select 1 from public.businesses b where b.id=business_id and b.status='active') or kapani_private.business_permission(business_id,'catalog')));
create policy business_orders_read on public.business_orders for select to authenticated using(kapani_private.active() and (buyer_id=auth.uid() or kapani_private.business_permission(business_id,'orders') or kapani_private.mayor()));
create policy business_items_read on public.business_order_items for select to authenticated using(kapani_private.active() and exists(select 1 from public.business_orders o where o.id=order_id and (o.buyer_id=auth.uid() or kapani_private.business_permission(o.business_id,'orders') or kapani_private.mayor())));
create policy business_history_read on public.business_order_history for select to authenticated using(kapani_private.active() and exists(select 1 from public.business_orders o where o.id=order_id and (o.buyer_id=auth.uid() or kapani_private.business_permission(o.business_id,'orders') or kapani_private.mayor())));
create policy market_decisions_read on public.market_dispute_decisions for select to authenticated using(kapani_private.active() and (kapani_private.mayor() or exists(select 1 from public.orders o where o.id=order_id and auth.uid() in(o.buyer_id,o.seller_id))));
create trigger immutable_shop_items before update or delete on public.business_order_items for each row execute function kapani_private.immutable();
create trigger immutable_shop_history before update or delete on public.business_order_history for each row execute function kapani_private.immutable();
create trigger immutable_market_decisions before update or delete on public.market_dispute_decisions for each row execute function kapani_private.immutable();
create function public.save_business_product(p_id uuid,p_business uuid,p_title text,p_description text,p_price bigint,p_stock integer,p_active boolean) returns uuid language plpgsql security definer set search_path='' as $$begin
 if not kapani_private.business_permission(p_business,'catalog') then raise exception 'Access denied';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,41));
 if exists(select 1 from public.business_products where id=p_id and business_id<>p_business) then raise exception 'Access denied';end if;
 insert into public.business_products(id,business_id,title,description,price,stock,active) values(p_id,p_business,p_title,p_description,p_price,p_stock,p_active) on conflict(id) do update set title=excluded.title,description=excluded.description,price=excluded.price,stock=excluded.stock,active=excluded.active,updated_at=now();
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'business.product',p_id,jsonb_build_object('price',p_price,'available_stock',p_stock,'active',p_active));return p_id;
end$$;
create function public.checkout_business(p_business uuid,p_items jsonb,p_expected_total bigint,p_comment text,p_key uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.businesses;o public.business_orders;r record;total bigint:=0;w uuid;e uuid;tx uuid;n integer;
begin
 if not kapani_private.active() or not exists(select 1 from public.profiles where id=auth.uid() and verified) then raise exception 'Municipal verification required';end if;
 if p_key is null or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 30 or p_expected_total is null then raise exception 'Invalid cart';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,42));
 select * into o from public.business_orders where buyer_id=auth.uid() and idempotency_key=p_key;
 if found then
 if o.business_id<>p_business or o.total<>p_expected_total or o.comment is distinct from p_comment or (select jsonb_agg(jsonb_build_object('product_id',i.product_id,'quantity',i.quantity) order by i.product_id) from public.business_order_items i where i.order_id=o.id) is distinct from (select jsonb_agg(jsonb_build_object('product_id',x.product_id,'quantity',x.quantity) order by x.product_id) from jsonb_to_recordset(p_items) x(product_id uuid,quantity integer)) then raise exception 'Idempotency conflict';end if;return o.id;end if;
 select * into b from public.businesses where id=p_business and status='active' for share;
 if not found or b.owner_id=auth.uid() then raise exception 'Business unavailable';end if;
 if exists(select 1 from jsonb_to_recordset(p_items) x(product_id uuid,quantity integer) where x.product_id is null or x.quantity is null or x.quantity not between 1 and 99) or (select count(distinct x.product_id) from jsonb_to_recordset(p_items) x(product_id uuid,quantity integer))<>jsonb_array_length(p_items) then raise exception 'Invalid cart';end if;
 perform 1 from public.business_products p where p.id in(select x.product_id from jsonb_to_recordset(p_items) x(product_id uuid,quantity integer)) order by p.id for update;
 select count(*),sum(p.price*x.quantity) into n,total from jsonb_to_recordset(p_items) x(product_id uuid,quantity integer) join public.business_products p on p.id=x.product_id where p.business_id=p_business and p.active and p.stock>=x.quantity;
 if n<>jsonb_array_length(p_items) then raise exception 'Stock unavailable';end if;
 if total<>p_expected_total then raise exception 'Price changed';end if;
 select id into w from public.accounts where owner_id=auth.uid() and kind='wallet';insert into public.accounts(kind) values('escrow') returning id into e;
 tx:=kapani_private.move_money(w,e,total,auth.uid(),'business_purchase_reserve');
 insert into public.business_orders(business_id,buyer_id,total,escrow_id,comment,idempotency_key) values(p_business,auth.uid(),total,e,p_comment,p_key) returning * into o;
 insert into public.business_order_items(order_id,product_id,title,unit_price,quantity) select o.id,p.id,p.title,p.price,x.quantity from jsonb_to_recordset(p_items) x(product_id uuid,quantity integer) join public.business_products p on p.id=x.product_id;
 update public.business_products p set stock=p.stock-i.quantity,updated_at=now() from public.business_order_items i where i.order_id=o.id and i.product_id=p.id;
 insert into public.business_order_history(order_id,actor,status,transaction_id) values(o.id,auth.uid(),'reserved',tx);
 insert into public.notifications(user_id,category,title,href) values(b.owner_id,'orders','Новый заказ организации','#shop'),(auth.uid(),'orders','Оплата заказа зарезервирована','#shop');return o.id;
end$$;
create function public.business_order_action(p_order uuid,p_action text,p_reason text default '') returns text language plpgsql security definer set search_path='' as $$
declare o public.business_orders;b public.businesses;next_status text;tx uuid;w uuid;manager boolean;
begin
 if not kapani_private.active() then raise exception 'Access denied';end if;
 select * into o from public.business_orders where id=p_order for update;if not found then raise exception 'Order unavailable';end if;
 select * into b from public.businesses where id=o.business_id;manager:=kapani_private.business_permission(b.id,'orders');
 if p_action='accept' then
 if not manager then raise exception 'Access denied';end if;if o.status='accepted' then return o.status;end if;if o.status<>'reserved' then raise exception 'Invalid transition';end if;next_status:='accepted';
 elsif p_action='ready' then
 if not manager then raise exception 'Access denied';end if;if o.status='ready' then return o.status;end if;if o.status<>'accepted' then raise exception 'Invalid transition';end if;next_status:='ready';
 elsif p_action='receive' then
 if o.buyer_id<>auth.uid() then raise exception 'Access denied';end if;if o.status='completed' then return o.status;end if;if o.status<>'ready' then raise exception 'Invalid transition';end if;
 tx:=kapani_private.move_money(o.escrow_id,b.account_id,o.total,auth.uid(),'business_purchase_settle');next_status:='completed';
 elsif p_action='cancel' then
 if o.buyer_id<>auth.uid() and not manager then raise exception 'Access denied';end if;if o.status='cancelled' then return o.status;end if;if o.status not in('reserved','accepted','ready') then raise exception 'Invalid transition';end if;
 if not manager and o.status<>'reserved' then raise exception 'Open dispute after acceptance';end if;
 select id into w from public.accounts where owner_id=o.buyer_id and kind='wallet';tx:=kapani_private.move_money(o.escrow_id,w,o.total,auth.uid(),'business_purchase_refund');next_status:='cancelled';
 perform 1 from public.business_products p join public.business_order_items i on i.product_id=p.id where i.order_id=o.id order by p.id for update of p;
 update public.business_products p set stock=p.stock+i.quantity from public.business_order_items i where i.order_id=o.id and i.product_id=p.id;
 elsif p_action='dispute' then
 if o.buyer_id<>auth.uid() then raise exception 'Access denied';end if;if o.status='disputed' then return o.status;end if;if o.status not in('reserved','accepted','ready') or length(trim(p_reason))<10 then raise exception 'Reason required';end if;next_status:='disputed';
 elsif p_action in('refund_dispute','settle_dispute') then
 if not kapani_private.mayor() or auth.uid() in(o.buyer_id,b.owner_id) or exists(select 1 from public.business_members where business_id=b.id and user_id=auth.uid() and active) then raise exception 'Access denied';end if;
 next_status:=case p_action when 'refund_dispute' then 'cancelled' else 'completed' end;
 if o.status=next_status and exists(select 1 from public.business_order_history where order_id=o.id and status=next_status and actor=auth.uid()) then return o.status;end if;
 if o.status<>'disputed' or length(trim(p_reason))<10 then raise exception 'Invalid transition';end if;
 if next_status='cancelled' then select id into w from public.accounts where owner_id=o.buyer_id and kind='wallet';else w:=b.account_id;end if;
 tx:=kapani_private.move_money(o.escrow_id,w,o.total,auth.uid(),'business_dispute_resolution');
 if next_status='cancelled' then
 perform 1 from public.business_products p join public.business_order_items i on i.product_id=p.id where i.order_id=o.id order by p.id for update of p;
 update public.business_products p set stock=p.stock+i.quantity from public.business_order_items i where i.order_id=o.id and i.product_id=p.id;end if;
 else raise exception 'Invalid action';end if;
 update public.business_orders set status=next_status,updated_at=now() where id=o.id;
 insert into public.business_order_history(order_id,actor,status,reason,transaction_id) values(o.id,auth.uid(),next_status,p_reason,tx);
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'business.order.'||p_action,o.id,jsonb_build_object('status',next_status,'reason',p_reason,'transaction',tx));
 insert into public.notifications(user_id,category,title,body,href) values(o.buyer_id,'orders','Обновление заказа организации',next_status,'#shop'),(b.owner_id,'orders','Обновление заказа организации',next_status,'#shop');
 if next_status='completed' then insert into public.task_events(user_id,kind,entity_id) values(o.buyer_id,'purchase_completed',o.id) on conflict do nothing;end if;return next_status;
end$$;
create function public.resolve_market_dispute(p_order uuid,p_refund boolean,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$declare o public.orders;d public.market_dispute_decisions;w uuid;tx uuid;begin
 if not kapani_private.mayor() then raise exception 'Access denied';end if;
 select * into o from public.orders where id=p_order for update;
 if not found or auth.uid() in(o.buyer_id,o.seller_id) then raise exception 'Access denied';end if;
 select * into d from public.market_dispute_decisions where order_id=p_order;
 if found then if d.refund is distinct from p_refund or d.reason is distinct from p_reason then raise exception 'Idempotency conflict';end if;return d.transaction_id;end if;
 if o.status<>'disputed' or p_refund is null or length(trim(p_reason))<10 then raise exception 'Invalid transition';end if;
 select id into w from public.accounts where owner_id=case when p_refund then o.buyer_id else o.seller_id end and kind='wallet';
 tx:=kapani_private.move_money(o.escrow_id,w,o.total,auth.uid(),'market_dispute_resolution');
 if p_refund then update public.listings set stock=stock+o.quantity where id=o.listing_id;end if;
 update public.orders set status=case when p_refund then 'cancelled' else 'completed' end,updated_at=now() where id=o.id;
 insert into public.market_dispute_decisions(order_id,actor,refund,reason,transaction_id) values(o.id,auth.uid(),p_refund,p_reason,tx);
 insert into public.audit_log(actor,action,entity,details) values(auth.uid(),'market.dispute',o.id,jsonb_build_object('refund',p_refund,'reason',p_reason,'transaction',tx));
 insert into public.notifications(user_id,category,title,body,href) values(o.buyer_id,'orders','Спор рассмотрен',p_reason,'#market'),(o.seller_id,'orders','Спор рассмотрен',p_reason,'#market');return tx;
end$$;
revoke all on function public.save_business_product(uuid,uuid,text,text,bigint,integer,boolean),public.checkout_business(uuid,jsonb,bigint,text,uuid),public.business_order_action(uuid,text,text),public.resolve_market_dispute(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.save_business_product(uuid,uuid,text,text,bigint,integer,boolean),public.checkout_business(uuid,jsonb,bigint,text,uuid),public.business_order_action(uuid,text,text),public.resolve_market_dispute(uuid,boolean,text) to authenticated;
-- Mayors need the dispute queue, never direct mutation rights.
create policy mayor_market_disputes_read on public.orders for select to authenticated using(kapani_private.mayor() and status='disputed');
commit;
