import type postgres from 'postgres';
import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { encryptSecret, generateApiKey, keyHint, sha256 } from '../lib/crypto.js';
import { AppError, assertFound } from '../lib/errors.js';
import { selectCredentialWithCapacity } from './capacity.js';
import { createCheckout, type PaymentProviderName } from './payments.js';
import { retailMultiplier, retailPrice } from './pricing.js';
import { requireRubRate } from './price-rates.js';

interface ProductRow {
  id: string;
  poolId: string;
  name: string;
  wholesaleCredits: string;
  currency: string;
  durationDays: number | null;
  concurrencyLimit: number;
  active: boolean;
}

interface OrderRow {
  id: string;
  userId: string;
  productId: string;
  upstreamCredentialId: string | null;
  poolId: string;
  status: string;
  paymentProvider: string;
  amount: string;
  creditAmount: string;
  grantLabel: string;
  grantDurationDays: number | null;
  grantConcurrencyLimit: number;
  topUpKeyId: string | null;
}

interface CreatedOrder {
  id: string;
  amount: string;
  currency: string;
  status: string;
  reservedUntil: Date;
  createdAt: Date;
  productName: string;
}

async function lockTopUpKey(transaction: postgres.TransactionSql, keyId: string, userId: string) {
  const [key] = await transaction<{
    id: string;
    status: string;
    expiresAt: Date | null;
    upstreamCredentialId: string;
    poolId: string;
    label: string;
    paymentProvider: PaymentProviderName;
    testPayment: boolean;
    creditsTotal: string;
    creditsUsed: string;
    amount: string;
    wholesaleCredits: string;
  }[]>`
    SELECT ak.id, ak.status, ak.expires_at, ak.upstream_credential_id, ak.label,
      ak.credits_total::text, ak.credits_used::text, o.pool_id, o.payment_provider,
      COALESCE(o.credit_amount, o.amount)::text AS amount, o.wholesale_credits::text,
      (o.payment_provider = 'mock' OR COALESCE(o.metadata->>'testPayment' = 'true', false)) AS test_payment
    FROM api_keys ak JOIN orders o ON o.id = ak.order_id
    WHERE ak.id = ${keyId} AND ak.user_id = ${userId}
    FOR UPDATE OF ak
  `;
  const owned = assertFound(key, 'KEY_NOT_FOUND', 'API key not found');
  if (owned.testPayment && (config.NODE_ENV === 'production'
    || (owned.paymentProvider === 'mock' ? !config.ALLOW_MOCK_PAYMENTS : !config.YOOKASSA_TEST_MODE))) {
    throw new AppError(409, 'KEY_TOP_UP_UNAVAILABLE', 'Test payment keys cannot be topped up in this environment');
  }
  if (owned.expiresAt !== null || !['ACTIVE', 'EXHAUSTED'].includes(owned.status)) {
    throw new AppError(409, 'KEY_TOP_UP_UNAVAILABLE', 'This key cannot be topped up');
  }
  return owned;
}

function topUpBudget(key: Awaited<ReturnType<typeof lockTopUpKey>>, amount: Decimal.Value): string {
  const balance = Decimal.max(new Decimal(key.creditsTotal).sub(key.creditsUsed), 0);
  return balance.add(amount).div(retailMultiplier(key.amount, key.wholesaleCredits)).toFixed(8, Decimal.ROUND_UP);
}

export async function createOrder(input: {
  userId: string;
  userEmail: string;
  productId: string;
  paymentProvider: PaymentProviderName;
  paymentCurrency?: 'RUB' | 'USDT' | undefined;
  topUpKeyId?: string | undefined;
}): Promise<Record<string, unknown>> {
  if (!config.salesEnabled) throw new AppError(503, 'SALES_DISABLED', 'New key sales are disabled');
  if (!config.paymentMethods.includes(input.paymentProvider)) {
    throw new AppError(400, 'PAYMENT_PROVIDER_DISABLED', 'The selected payment method is not enabled');
  }
  const currency = input.paymentCurrency ?? (input.paymentProvider === 'yookassa' ? 'RUB' : 'USDT');
  if (!config.paymentCurrencies.includes(currency)) {
    throw new AppError(400, 'PAYMENT_CURRENCY_DISABLED', 'The selected payment currency is not enabled');
  }
  if ((input.paymentProvider === 'yookassa' && currency !== 'RUB')
    || (['nowpayments', 'ton'].includes(input.paymentProvider) && currency !== 'USDT')) {
    throw new AppError(400, 'INVALID_PAYMENT_CURRENCY', 'The selected payment method does not support this currency');
  }
  const rubRate = currency === 'RUB' ? await requireRubRate() : null;

  const order: CreatedOrder = await sql.begin(async (transaction) => {
    const products = await transaction<ProductRow[]>`
      SELECT id, pool_id, name, wholesale_credits::text, currency, duration_days, concurrency_limit, active
      FROM products
      WHERE id = ${input.productId}
      FOR SHARE
    `;
    const product = assertFound(products[0], 'PRODUCT_NOT_FOUND', 'Product not found');
    if (!product.active) throw new AppError(409, 'PRODUCT_DISABLED', 'Product is not available');

    const creditAmount = retailPrice(product.wholesaleCredits);
    const amount = rubRate ? creditAmount.mul(rubRate.usdtToRub).toDecimalPlaces(2) : creditAmount;
    if (product.currency !== 'USDT' || creditAmount.lt('0.01') || amount.lt('0.01')) {
      throw new AppError(409, 'PRODUCT_PRICE_INVALID', 'The product must have a positive USDT price');
    }
    const allowTest = input.paymentProvider === 'mock';
    const key = input.topUpKeyId ? await lockTopUpKey(transaction, input.topUpKeyId, input.userId) : null;
    if (key && (key.poolId !== product.poolId || product.durationDays !== null)) {
      throw new AppError(409, 'TOP_UP_PRODUCT_MISMATCH', 'This package is unavailable for the selected key');
    }
    if (key && allowTest !== (key.paymentProvider === 'mock')) {
      throw new AppError(400, 'TOP_UP_PAYMENT_METHOD_MISMATCH', 'This payment method is unavailable for the selected key');
    }
    const credential = await selectCredentialWithCapacity(transaction, product.poolId, {
      linkedPools: true, allowTest,
      ...(key && { apiKeyId: key.id, preferredCredentialId: key.upstreamCredentialId, minimumBudget: topUpBudget(key, creditAmount) }),
    });
    const productName = key ? `API key top-up · ${product.name}` : product.name;
    const reservationMinutes = input.paymentProvider === 'ton' ? config.TON_INVOICE_TTL_MINUTES
      : input.paymentProvider === 'yookassa' ? 60 : input.paymentProvider === 'nowpayments' ? 25 : 1440;
    const reservedUntil = new Date(Math.floor(Date.now() / 1000) * 1000 + reservationMinutes * 60_000);
    const rows = await transaction<Omit<CreatedOrder, 'productName'>[]>`
      INSERT INTO orders (
        user_id, product_id, upstream_credential_id, payment_provider, currency,
        amount, price_markup, wholesale_credits, reserved_until, pool_id,
        grant_label, grant_duration_days, grant_concurrency_limit, top_up_key_id, credit_amount, usdt_rub_rate, exchange_rate_at
      ) VALUES (
        ${input.userId}, ${product.id}, ${credential.id}, ${input.paymentProvider},
        ${currency}, ${amount.toFixed(2)}, ${config.PRICE_MARKUP},
        ${product.wholesaleCredits}, ${reservedUntil}, ${product.poolId},
        ${product.name}, ${product.durationDays}, ${product.concurrencyLimit}, ${key?.id ?? null},
        ${creditAmount.toFixed(8)}, ${rubRate?.usdtToRub ?? null}, ${rubRate ? new Date(rubRate.checkedAt) : null}
      )
      RETURNING id, amount::text, currency, status, reserved_until, created_at
    `;
    return { ...assertFound(rows[0], 'ORDER_CREATE_FAILED', 'Unable to create order'), productName };
  });

  try {
    const checkout = await createCheckout(input.paymentProvider, {
      id: String(order.id),
      amount: String(order.amount),
      currency: String(order.currency),
      productName: order.productName,
      userEmail: input.userEmail,
      reservedUntil: order.reservedUntil,
    });
    const [updated] = await sql<Record<string, unknown>[]>`
      UPDATE orders SET
        external_id = ${checkout.externalId},
        checkout_url = ${checkout.checkoutUrl},
        metadata = metadata || ${sql.json((checkout.metadata ?? {}) as never)},
        reserved_until = ${checkout.expiresAt ?? order.reservedUntil},
        updated_at = now()
      WHERE id = ${String(order.id)}
      RETURNING id, status, amount::text, currency, credit_amount::text, usdt_rub_rate::text, exchange_rate_at,
        checkout_url, metadata, reserved_until, created_at, top_up_key_id
    `;
    return assertFound(updated, 'ORDER_NOT_FOUND', 'Order disappeared during checkout');
  } catch (error) {
    await sql`UPDATE orders SET status = 'FAILED', updated_at = now() WHERE id = ${order.id} AND status = 'PENDING'`;
    throw error;
  }
}

export async function fulfillPaidOrder(orderId: string): Promise<{ apiKeyId: string; created: boolean }> {
  return sql.begin(async (transaction) => {
    const rows = await transaction<OrderRow[]>`
      SELECT id, user_id, product_id, upstream_credential_id, pool_id, status, payment_provider, amount::text,
        COALESCE(credit_amount, amount)::text AS credit_amount,
        grant_label, grant_duration_days, grant_concurrency_limit, top_up_key_id
      FROM orders WHERE id = ${orderId}
      FOR UPDATE
    `;
    const order = assertFound(rows[0], 'ORDER_NOT_FOUND', 'Order not found');
    if (order.status === 'FULFILLED' && order.topUpKeyId) return { apiKeyId: order.topUpKeyId, created: false };
    const existing = await transaction<{ id: string }[]>`SELECT id FROM api_keys WHERE order_id = ${order.id}`;
    if (existing[0]) return { apiKeyId: existing[0].id, created: false };
    if (order.status !== 'PAID') {
      throw new AppError(409, 'ORDER_NOT_FULFILLABLE', `Order is ${order.status.toLowerCase()}`);
    }

    const key = order.topUpKeyId ? await lockTopUpKey(transaction, order.topUpKeyId, order.userId) : null;
    const { id: credentialId, poolId } = await selectCredentialWithCapacity(transaction, order.poolId, {
      orderId: order.id,
      preferredCredentialId: order.upstreamCredentialId ?? key?.upstreamCredentialId ?? null,
      linkedPools: true,
      allowTest: order.paymentProvider === 'mock',
      ...(key && { apiKeyId: key.id, minimumBudget: topUpBudget(key, order.creditAmount) }),
    });

    if (key) {
      if (key.status === 'EXHAUSTED' || key.upstreamCredentialId !== credentialId) {
        // Exhaustion releases linked slots. Reacquire them lazily on the next request.
        await transaction`
          DELETE FROM api_key_channel_assignments
          WHERE api_key_id = ${key.id} AND (${key.status === 'EXHAUSTED'} OR pool_id = ${poolId})
        `;
      }
      await transaction`
        UPDATE api_keys SET credits_total = credits_total + ${order.creditAmount}, status = 'ACTIVE',
          upstream_credential_id = ${credentialId}, updated_at = now()
        WHERE id = ${key.id}
      `;
      await completeOrder(transaction, order.id, credentialId);
      return { apiKeyId: key.id, created: false };
    }

    const secret = generateApiKey();
    const expiresAt = order.grantDurationDays
      ? new Date(Date.now() + order.grantDurationDays * 86_400_000)
      : null;
    const [apiKey] = await transaction<{ id: string }[]>`
      INSERT INTO api_keys (
        user_id, product_id, order_id, upstream_credential_id, key_hash, encrypted_key,
        key_hint, label, credits_total, concurrency_limit, expires_at
      ) VALUES (
        ${order.userId}, ${order.productId}, ${order.id}, ${credentialId},
        ${sha256(secret)}, ${encryptSecret(secret)}, ${keyHint(secret)}, ${order.grantLabel},
        ${order.creditAmount}, ${order.grantConcurrencyLimit}, ${expiresAt}
      )
      RETURNING id
    `;
    const created = assertFound(apiKey, 'KEY_CREATE_FAILED', 'Unable to create API key');
    await completeOrder(transaction, order.id, credentialId);
    return { apiKeyId: created.id, created: true };
  });
}

async function completeOrder(transaction: postgres.TransactionSql, orderId: string, credentialId: string): Promise<void> {
  await transaction`
    UPDATE orders SET status = 'FULFILLED', upstream_credential_id = ${credentialId}, paid_at = COALESCE(paid_at, now()),
      fulfilled_at = now(), updated_at = now()
    WHERE id = ${orderId}
  `;
}

export async function markOrderPaid(orderId: string, transaction: postgres.TransactionSql): Promise<void> {
  await transaction`
    UPDATE orders SET status = CASE WHEN status = 'FULFILLED' THEN status ELSE 'PAID' END,
      upstream_credential_id = CASE WHEN status IN ('EXPIRED', 'FAILED')
        OR (status = 'PENDING' AND reserved_until <= now()) THEN NULL ELSE upstream_credential_id END,
      paid_at = COALESCE(paid_at, now()), updated_at = now()
    WHERE id = ${orderId} AND status IN ('PENDING', 'PAID', 'FULFILLED', 'EXPIRED', 'FAILED')
  `;
}

export async function tryFulfillPaidOrder(orderId: string): Promise<void> {
  try {
    await fulfillPaidOrder(orderId);
  } catch (error) {
    if (!(error instanceof AppError) || !['NO_UPSTREAM_CAPACITY', 'KEY_TOP_UP_UNAVAILABLE'].includes(error.code)) throw error;
  }
}

export async function retryPaidOrders(): Promise<void> {
  const orders = await sql<{ id: string }[]>`
    SELECT o.id FROM orders o
    LEFT JOIN api_keys ak ON ak.id = o.top_up_key_id
    LEFT JOIN orders original ON original.id = ak.order_id
    WHERE o.status = 'PAID' AND (o.top_up_key_id IS NULL OR (ak.status IN ('ACTIVE', 'EXHAUSTED') AND ak.expires_at IS NULL))
      AND EXISTS (
      SELECT 1 FROM sellable_upstream_slots s JOIN pool_channels c ON c.pool_id = s.pool_id
      JOIN upstream_credentials uc ON uc.id = s.id
      WHERE c.root_pool_id = o.pool_id
        AND (NOT s.test_only OR o.payment_provider = 'mock')
        AND (o.top_up_key_id IS NULL OR uc.spend_limit IS NULL OR uc.spend_limit - uc.spend_used
          >= (GREATEST(ak.credits_total - ak.credits_used, 0) + COALESCE(o.credit_amount, o.amount))
            * original.wholesale_credits / COALESCE(original.credit_amount, original.amount))
        AND (s.credential_capacity IS NULL OR s.assigned + s.reserved - CASE WHEN EXISTS (
          SELECT 1 FROM upstream_slot_claims claim WHERE claim.upstream_credential_id = s.id
            AND (claim.order_id = o.id OR claim.api_key_id = o.top_up_key_id)
        ) THEN 1 ELSE 0 END < s.credential_capacity)
    ) ORDER BY o.paid_at, o.id LIMIT 50
  `;
  for (const order of orders) {
    try {
      await tryFulfillPaidOrder(order.id);
    } catch {
      console.error('Could not fulfill paid order', order.id);
    }
  }
}
