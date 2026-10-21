-- Demo data. Run in the Supabase SQL editor AFTER creating a user in
-- Authentication > Users. Replace the email below with that user's email.

with t as (
  insert into public.tenants (name, currency) values ('Demo Coffee Shop', 'usd')
  returning id
), m as (
  insert into public.memberships (user_id, tenant_id, role)
  select u.id, t.id, 'owner'
  from auth.users u, t
  where u.email = 'you@example.com'
  returning tenant_id
)
insert into public.products (tenant_id, sku, name, price_cents, tax_rate_bps)
select t.id, v.sku, v.name, v.price, v.tax
from t, (values
  ('ESP',  'Espresso',        300, 800),
  ('LAT',  'Latte',           450, 800),
  ('CRS',  'Butter Croissant',375, 800),
  ('BEAN', 'Beans 250g',     1400, 800)
) as v(sku, name, price, tax);
