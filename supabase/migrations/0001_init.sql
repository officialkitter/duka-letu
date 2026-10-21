-- =====================================================================
-- Duka-tetu: single database, shared tables, tenant isolation via RLS.
--
-- Tenant identity travels in the Supabase JWT as the custom claim
-- `tenant_id` (plus `pos_role`), injected by the Custom Access Token
-- Hook defined below. The Fastify API connects with a normal DB role,
-- opens a transaction, sets `request.jwt.claims`, switches to the
-- `authenticated` role (which has NO bypassrls) and then runs queries.
-- Every policy keys off app.tenant_id(), never off request payloads.
-- =====================================================================

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Core identity tables
-- ---------------------------------------------------------------------
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  currency    char(3) not null default 'usd',
  created_at  timestamptz not null default now()
);

create type public.member_role as enum ('owner', 'manager', 'cashier');

create table public.memberships (
  user_id     uuid not null references auth.users(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  role        public.member_role not null default 'cashier',
  created_at  timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
create index memberships_tenant_idx on public.memberships (tenant_id);

-- ---------------------------------------------------------------------
-- Claim helpers (read from the JWT claims GUC; same source as auth.jwt())
-- ---------------------------------------------------------------------
create or replace function app.claims() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function app.tenant_id() returns uuid
language sql stable as $$
  select nullif(app.claims() ->> 'tenant_id', '')::uuid
$$;

create or replace function app.pos_role() returns text
language sql stable as $$
  select app.claims() ->> 'pos_role'
$$;

create or replace function app.user_id() returns uuid
language sql stable as $$
  select nullif(app.claims() ->> 'sub', '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Custom Access Token Hook: stamps tenant_id + pos_role into the JWT.
-- Enable in Supabase Dashboard: Authentication > Hooks > Custom Access Token
-- and point it at public.custom_access_token_hook.
-- (Users with several tenants get the oldest membership; add a tenant
--  switcher that stores a preference if you need multi-tenant users.)
-- ---------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
as $$
declare
  claims jsonb := event -> 'claims';
  m record;
begin
  select tenant_id, role into m
  from public.memberships
  where user_id = (event ->> 'user_id')::uuid
  order by created_at asc
  limit 1;

  if found then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(m.tenant_id::text));
    claims := jsonb_set(claims, '{pos_role}', to_jsonb(m.role::text));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.memberships to supabase_auth_admin;

-- ---------------------------------------------------------------------
-- Sync cursor support: server_updated_at is stamped by trigger, never by
-- the client, so pull cursors are not skewed by device clocks.
-- ---------------------------------------------------------------------
create or replace function app.touch_server_updated_at() returns trigger
language plpgsql as $$
begin
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------
create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  sku                text,
  name               text not null,
  price_cents        integer not null check (price_cents >= 0),
  tax_rate_bps       integer not null default 0 check (tax_rate_bps between 0 and 10000),
  active             boolean not null default true,
  deleted_at         timestamptz,
  server_updated_at  timestamptz not null default clock_timestamp()
);
create index products_tenant_sync_idx on public.products (tenant_id, server_updated_at);
create unique index products_tenant_sku_uniq on public.products (tenant_id, sku) where sku is not null and deleted_at is null;
create trigger products_touch before insert or update on public.products
  for each row execute function app.touch_server_updated_at();

-- ---------------------------------------------------------------------
-- Sales. IDs are generated on the device (UUIDv4) so offline creation and
-- retried pushes are idempotent: INSERT ... ON CONFLICT (id) DO NOTHING.
-- Sales are append-only; corrections are new rows (refund/void) later.
-- ---------------------------------------------------------------------
create type public.sale_status as enum ('completed', 'voided');
create type public.payment_method as enum ('cash', 'card');

create table public.sales (
  id                 uuid primary key,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  device_id          text not null,
  cashier_id         uuid not null references auth.users(id),
  status             public.sale_status not null default 'completed',
  currency           char(3) not null,
  subtotal_cents     integer not null check (subtotal_cents >= 0),
  tax_cents          integer not null check (tax_cents >= 0),
  total_cents        integer not null check (total_cents >= 0),
  occurred_at        timestamptz not null,           -- device clock, informational
  server_updated_at  timestamptz not null default clock_timestamp(),
  check (total_cents = subtotal_cents + tax_cents)
);
create index sales_tenant_sync_idx on public.sales (tenant_id, server_updated_at);
create trigger sales_touch before insert or update on public.sales
  for each row execute function app.touch_server_updated_at();

create table public.sale_lines (
  id                 uuid primary key,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  sale_id            uuid not null references public.sales(id) on delete cascade,
  product_id         uuid references public.products(id),
  name               text not null,                  -- snapshot at time of sale
  quantity           integer not null check (quantity > 0),
  unit_price_cents   integer not null check (unit_price_cents >= 0),
  tax_cents          integer not null check (tax_cents >= 0),
  line_total_cents   integer not null check (line_total_cents >= 0),
  server_updated_at  timestamptz not null default clock_timestamp()
);
create index sale_lines_sale_idx on public.sale_lines (tenant_id, sale_id);
create index sale_lines_tenant_sync_idx on public.sale_lines (tenant_id, server_updated_at);
create trigger sale_lines_touch before insert or update on public.sale_lines
  for each row execute function app.touch_server_updated_at();

create table public.payments (
  id                         uuid primary key,
  tenant_id                  uuid not null references public.tenants(id) on delete cascade,
  sale_id                    uuid not null references public.sales(id) on delete cascade,
  method                     public.payment_method not null,
  amount_cents               integer not null check (amount_cents > 0),
  stripe_payment_intent_id   text,
  server_updated_at          timestamptz not null default clock_timestamp(),
  check (method <> 'card' or stripe_payment_intent_id is not null)
);
create index payments_sale_idx on public.payments (tenant_id, sale_id);
create index payments_tenant_sync_idx on public.payments (tenant_id, server_updated_at);
-- A PaymentIntent can back at most one payment row, globally.
create unique index payments_pi_uniq on public.payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create trigger payments_touch before insert or update on public.payments
  for each row execute function app.touch_server_updated_at();

-- ---------------------------------------------------------------------
-- Row-Level Security. FORCE makes it apply to the table owner too, so a
-- mistakenly-configured connection role cannot silently bypass it.
-- ---------------------------------------------------------------------
alter table public.tenants     enable row level security;
alter table public.memberships enable row level security;
alter table public.products    enable row level security;
alter table public.sales       enable row level security;
alter table public.sale_lines  enable row level security;
alter table public.payments    enable row level security;

alter table public.tenants     force row level security;
alter table public.memberships force row level security;
alter table public.products    force row level security;
alter table public.sales       force row level security;
alter table public.sale_lines  force row level security;
alter table public.payments    force row level security;

-- tenants / memberships: read-only to members of that tenant
create policy tenants_read on public.tenants
  for select to authenticated
  using (id = app.tenant_id());

create policy memberships_read on public.memberships
  for select to authenticated
  using (tenant_id = app.tenant_id());

-- products: all members read; owner/manager write
create policy products_read on public.products
  for select to authenticated
  using (tenant_id = app.tenant_id());

create policy products_write on public.products
  for all to authenticated
  using (tenant_id = app.tenant_id() and app.pos_role() in ('owner', 'manager'))
  with check (tenant_id = app.tenant_id() and app.pos_role() in ('owner', 'manager'));

-- sales / lines / payments: members read; members insert for own tenant
-- (cashier_id must be the caller); no update/delete policy => append-only.
create policy sales_read on public.sales
  for select to authenticated
  using (tenant_id = app.tenant_id());

create policy sales_insert on public.sales
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and cashier_id = app.user_id());

create policy sale_lines_read on public.sale_lines
  for select to authenticated
  using (tenant_id = app.tenant_id());

create policy sale_lines_insert on public.sale_lines
  for insert to authenticated
  with check (tenant_id = app.tenant_id());

create policy payments_read on public.payments
  for select to authenticated
  using (tenant_id = app.tenant_id());

create policy payments_insert on public.payments
  for insert to authenticated
  with check (tenant_id = app.tenant_id());

-- ---------------------------------------------------------------------
-- Privileges for the role the API assumes inside each transaction.
-- Browsers never talk to these tables directly (no PostgREST exposure):
-- revoke from anon so the Supabase Data API cannot be used to bypass the API.
-- ---------------------------------------------------------------------
revoke all on public.tenants, public.memberships, public.products,
              public.sales, public.sale_lines, public.payments from anon;

grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;

grant select on public.tenants, public.memberships to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert on public.sales, public.sale_lines, public.payments to authenticated;
