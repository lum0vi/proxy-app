ALTER TABLE products ALTER COLUMN currency TYPE text;
UPDATE products SET currency = 'USDT' WHERE currency = 'USD';
ALTER TABLE products ALTER COLUMN currency SET DEFAULT 'USDT';

-- Retain the original payment currency for old receipts and delayed webhooks.
ALTER TABLE orders ALTER COLUMN currency TYPE text;
ALTER TABLE orders ADD COLUMN credit_amount numeric(20,8) CHECK (credit_amount > 0),
  ADD COLUMN usdt_rub_rate numeric(20,8) CHECK (usdt_rub_rate > 0),
  ADD COLUMN exchange_rate_at timestamptz;
UPDATE orders SET credit_amount = amount;
ALTER TABLE orders ALTER COLUMN credit_amount SET NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_payment_provider_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_provider_check
  CHECK (payment_provider IN ('stripe', 'nowpayments', 'yookassa', 'mock'));
ALTER TABLE orders ADD CONSTRAINT orders_rub_quote_check CHECK (
  payment_provider <> 'yookassa' OR (currency = 'RUB' AND usdt_rub_rate IS NOT NULL
    AND exchange_rate_at IS NOT NULL AND amount = round(credit_amount * usdt_rub_rate, 2))
), ADD CONSTRAINT orders_usdt_credit_check CHECK (currency <> 'USDT' OR amount = credit_amount);

-- Preserve the purchasing allowance: existing credit units become USDT 1:1.
-- Wholesale costs and supplier balances retain their native USD denomination.
ALTER TABLE api_keys ADD COLUMN currency text NOT NULL DEFAULT 'USDT' CHECK (currency = 'USDT');
