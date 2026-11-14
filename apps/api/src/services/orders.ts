import type postgres from 'postgres';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { encryptSecret, generateApiKey, keyHint, sha256 } from '../lib/crypto.js';
import { AppError, assertFound } from '../lib/errors.js';
import { selectCredentialWithCapacity } from './capacity.js';
import { createCheckout, type PaymentProviderName } from './payments.js';
import { retailPrice } from './pricing.js';

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
  grantLabel: string;
  grantDurationDays: number | null;
  grantConcurrencyLimit: number;
}

interface CreatedOrder {
  id: string;
  amount: string;
  currency: string;
  status: string;
  reservedUntil: Date;
  createdAt: Date;
  product: ProductRow;
}

export async function createOrder(input: {
  userId: string;
  userEmail: string;
  productId: string;
  paymentProvider: PaymentProviderName;
}): Promise<Record<string, unknown>> {
  if (!config.salesEnabled) throw new AppError(503, 'SALES_DISABLED', 'New key sales are disabled');
  if (!config.paymentMethods.includes(input.paymentProvider)) {
    throw new AppError(400, 'PAYMENT_PROVIDER_DISABLED', 'The selected payment method is not enabled');
  }

  const order: CreatedOrder = await sql.begin(async (transaction) => {
    const products = await transaction<ProductRow[]>`
      SELECT id, pool_id, name, wholesale_credits::text, currency, duration_days, concurrency_limit, active
      FROM products
      WHERE id = ${input.productId}
      FOR SHARE
    `;
    const product = assertFound(products[0], 'PRODUCT_NOT_FOUND', 'Product not found');
    if (!product.active) throw new AppError(409, 'PRODUCT_DISABLED', 'Product is not available');

    const amount = retailPrice(product.wholesaleCredits);
    if (product.currency !== 'USD' || amount.lt('0.01')) {
      throw new AppError(409, 'PRODUCT_PRICE_INVALID', 'The product must have a positive USD price');
    }
    const credential = await selectCredentialWithCapacity(transaction, product.poolId, { linkedPools: true, allowTest: input.paymentProvider === 'mock' });
    const reservationMinutes = input.paymentProvider === 'stripe' ? 60 : input.paymentProvider === 'nowpayments' ? 25 : 1440;
    const reservedUntil = new Date(Math.floor(Date.now() / 1000) * 1000 + reservationMinutes * 60_000);
    const rows = await transaction<Omit<CreatedOrder, 'product'>[]>`
      INSERT INTO orders (
        user_id, product_id, upstream_credential_id, payment_provider, currency,
        amount, price_markup, wholesale_credits, reserved_until, pool_id,
        grant_label, grant_duration_days, grant_concurrency_limit
      ) VALUES (
        ${input.userId}, ${product.id}, ${credential.id}, ${input.paymentProvider},
        ${product.currency}, ${amount.toFixed(2)}, ${config.PRICE_MARKUP},
        ${product.wholesaleCredits}, ${reservedUntil}, ${product.poolId},
        ${product.name}, ${product.durationDays}, ${product.concurrencyLimit}
      )
      RETURNING id, amount::text, currency, status, reserved_until, created_at
    `;
    return { ...assertFound(rows[0], 'ORDER_CREATE_FAILED', 'Unable to create order'), product };
  });

  try {
    const checkout = await createCheckout(input.paymentProvider, {
      id: String(order.id),
      amount: String(order.amount),
      currency: String(order.currency),
      productName: order.product.name,
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
      RETURNING id, status, amount::text, currency, checkout_url, metadata, reserved_until, created_at
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
        grant_label, grant_duration_days, grant_concurrency_limit
      FROM orders WHERE id = ${orderId}
      FOR UPDATE
    `;
    const order = assertFound(rows[0], 'ORDER_NOT_FOUND', 'Order not found');
    const existing = await transaction<{ id: string }[]>`SELECT id FROM api_keys WHERE order_id = ${order.id}`;
    if (existing[0]) return { apiKeyId: existing[0].id, created: false };
    if (order.status !== 'PAID') {
      throw new AppError(409, 'ORDER_NOT_FULFILLABLE', `Order is ${order.status.toLowerCase()}`);
    }

    const { id: credentialId } = await selectCredentialWithCapacity(transaction, order.poolId, {
      paidReservationId: order.upstreamCredentialId,
      linkedPools: true,
      allowTest: order.paymentProvider === 'mock',
    });

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
        ${order.amount}, ${order.grantConcurrencyLimit}, ${expiresAt}
      )
      RETURNING id
    `;
    const created = assertFound(apiKey, 'KEY_CREATE_FAILED', 'Unable to create API key');
    await transaction`
      UPDATE orders SET
        status = 'FULFILLED', upstream_credential_id = ${credentialId}, paid_at = COALESCE(paid_at, now()),
        fulfilled_at = now(), updated_at = now()
      WHERE id = ${order.id}
    `;
    return { apiKeyId: created.id, created: true };
  });
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
    if (!(error instanceof AppError) || error.code !== 'NO_UPSTREAM_CAPACITY') throw error;
  }
}

export async function retryPaidOrders(): Promise<void> {
  const orders = await sql<{ id: string }[]>`
    SELECT o.id FROM orders o WHERE o.status = 'PAID' AND EXISTS (
      SELECT 1 FROM sellable_upstream_slots s JOIN pool_channels c ON c.pool_id = s.pool_id
      WHERE c.root_pool_id = o.pool_id
        AND (NOT s.test_only OR o.payment_provider = 'mock')
        AND s.assigned + s.reserved - CASE WHEN s.id = o.upstream_credential_id THEN 1 ELSE 0 END < s.credential_capacity
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
