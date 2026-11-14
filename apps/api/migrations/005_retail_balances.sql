ALTER TABLE usage_records ADD COLUMN retail_cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (retail_cost >= 0);
ALTER TABLE request_leases ADD COLUMN retail_reserved_cost numeric(20,8) NOT NULL DEFAULT 0 CHECK (retail_reserved_cost >= 0);

WITH charges AS (
  SELECT ur.id, ur.api_key_id, ur.started_at, o.amount,
    round(ur.cost * o.amount / o.wholesale_credits, 8) AS charge
  FROM usage_records ur JOIN api_keys ak ON ak.id = ur.api_key_id JOIN orders o ON o.id = ak.order_id
  WHERE ur.cost > 0
), totals AS (
  SELECT id, LEAST(charge, GREATEST(0, amount - COALESCE(sum(charge) OVER (
    PARTITION BY api_key_id ORDER BY started_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
  ), 0))) AS charge
  FROM charges
)
UPDATE usage_records ur SET retail_cost = totals.charge FROM totals WHERE ur.id = totals.id;

UPDATE request_leases rl SET retail_reserved_cost = round(rl.reserved_cost * o.amount / o.wholesale_credits, 8)
FROM api_keys ak JOIN orders o ON o.id = ak.order_id WHERE ak.id = rl.api_key_id;

UPDATE api_keys ak SET credits_total = o.amount,
  credits_used = LEAST(o.amount, COALESCE((SELECT sum(ur.retail_cost) FROM usage_records ur WHERE ur.api_key_id = ak.id), 0))
FROM orders o WHERE o.id = ak.order_id;

UPDATE notifications n SET payload = n.payload || jsonb_build_object('detail',
  CASE WHEN n.kind = 'KEY_CREATED' THEN ak.credits_total::text ELSE (ak.credits_total - ak.credits_used)::text END)
FROM api_keys ak WHERE n.api_key_id = ak.id AND n.status = 'PENDING' AND n.kind IN ('KEY_CREATED', 'KEY_BALANCE');
