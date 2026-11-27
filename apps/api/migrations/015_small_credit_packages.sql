-- The standard x2 markup gives 1, 2 and 5 USDT. Existing orders keep their
-- captured price and allowance; existing/custom packages are not overwritten.
INSERT INTO products (pool_id, name, slug, wholesale_credits, currency, duration_days, concurrency_limit)
SELECT p.pool_id, plan.name, plan.slug, plan.credits, 'USDT', NULL, 1
FROM products p CROSS JOIN (VALUES
  ('Mini Key', 'mini-key', 0.5::numeric),
  ('Starter Key', 'starter-key', 1::numeric),
  ('Basic Key', 'basic-key', 2.5::numeric)
) AS plan(name, slug, credits)
WHERE p.slug = 'developer-key'
ON CONFLICT (slug) DO NOTHING;
