import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { sql } from '../db/index.js';
import Stripe from 'stripe';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { Decimal } from 'decimal.js';
import { createYooKassaCheckout } from './yookassa.js';
import { USDT_TON_MASTER, tonAddress } from '../lib/ton.js';
import { Address } from '@ton/core';

export type PaymentProviderName = 'stripe' | 'nowpayments' | 'yookassa' | 'mock' | 'ton';

export interface CheckoutOrder {
  id: string;
  amount: string;
  currency: string;
  productName: string;
  userEmail: string;
  reservedUntil: Date;
}

export interface CheckoutResult {
  externalId: string;
  checkoutUrl: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

const stripe = config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY, { timeout: 20_000 }) : null;
const tonInvoiceAmountStep = '0.001';
const tonInvoiceAmountVariants = 2;

export async function createCheckout(
  provider: PaymentProviderName,
  order: CheckoutOrder,
): Promise<CheckoutResult> {
  if (provider === 'yookassa') return createYooKassaCheckout(order);
  if (provider === 'ton') {
    if (!config.TON_RECEIVER_ADDRESS) throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'TON payments are not configured');
    if (order.currency !== 'USDT') throw new AppError(400, 'INVALID_CURRENCY', 'TON checkout requires USDT');
    const receiver = tonAddress(config.TON_RECEIVER_ADDRESS);
    const payAmount = await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('ton-invoice-amount'), hashtext(${receiver}))`;
      const start = randomInt(1, tonInvoiceAmountVariants + 1);
      // Truncate before adding the suffix so rounding cannot exceed the 0.002 USDT cap.
      const [slot] = await tx<{ amount: string }[]>`SELECT candidate.amount::text FROM (
        SELECT trunc(${order.amount}::numeric, 3) + n * ${tonInvoiceAmountStep}::numeric AS amount
        FROM generate_series(1, ${tonInvoiceAmountVariants}::int) n
      ) candidate WHERE candidate.amount NOT IN (
        SELECT (metadata->>'payAmount')::numeric FROM orders WHERE payment_provider = 'ton'
          AND metadata->>'receiverRaw' = ${receiver} AND metadata->>'payAmount' IS NOT NULL
          AND reserved_until >= (SELECT created_at - interval '2 seconds' FROM orders WHERE id = ${order.id})
      ) ORDER BY candidate.amount < trunc(${order.amount}::numeric, 3) + ${start}::int * ${tonInvoiceAmountStep}::numeric,
        candidate.amount LIMIT 1`;
      if (!slot) throw new AppError(503, 'TON_INVOICES_BUSY', 'Please try creating an invoice later');
      const amount = new Decimal(slot.amount).toFixed(3);
      await tx`UPDATE orders SET metadata = metadata || ${tx.json({ receiverRaw: receiver, payAmount: amount })} WHERE id = ${order.id}`;
      return amount;
    });
    return {
      externalId: `ton_${order.id}`,
      checkoutUrl: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}`,
      expiresAt: order.reservedUntil,
      metadata: { payAddress: Address.parse(config.TON_RECEIVER_ADDRESS).toString({ bounceable: false }), receiverRaw: tonAddress(config.TON_RECEIVER_ADDRESS),
        payAmount, payCurrency: 'usdtton', network: 'TON', asset: 'USDT',
        verification: 'txid', master: USDT_TON_MASTER,
        autoApprove: true },
    };
  }
  if (provider === 'mock') {
    if (!config.ALLOW_MOCK_PAYMENTS || config.NODE_ENV === 'production') {
      throw new AppError(400, 'PAYMENT_PROVIDER_DISABLED', 'Mock payments are disabled');
    }
    return {
      externalId: `mock_${order.id}`,
      checkoutUrl: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}`,
      metadata: { mode: 'mock' },
    };
  }

  if (provider !== 'nowpayments') throw new AppError(400, 'PAYMENT_PROVIDER_DISABLED', 'This payment method is no longer available');

  if (!config.NOWPAYMENTS_API_KEY) {
    throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'NOWPayments is not configured');
  }
  if (order.currency !== 'USDT') throw new AppError(400, 'INVALID_CURRENCY', 'Crypto checkout requires USDT');
  const referenceAmount = new Decimal(order.amount).div(config.BILLING_USDT_PER_USD).toDecimalPlaces(8);

  let response: Response;
  let payload: Record<string, unknown> | null;
  try {
    response = await fetch(`${config.NOWPAYMENTS_API_URL.replace(/\/$/, '')}/payment`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.NOWPAYMENTS_API_KEY,
      },
      body: JSON.stringify({
        price_amount: referenceAmount.toNumber(),
        price_currency: 'usd',
        pay_amount: Number(order.amount),
        pay_currency: config.NOWPAYMENTS_PAY_CURRENCY,
        ipn_callback_url: `${config.PUBLIC_APP_URL}/api/webhooks/nowpayments`,
        order_id: order.id,
        order_description: order.productName,
        is_fixed_rate: true,
        is_fee_paid_by_user: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'The payment processor is temporarily unavailable');
  }
  const amount = payload?.pay_amount;
  if (!response.ok || !payload || !/^\d{1,35}$/.test(String(payload.payment_id ?? ''))
    || typeof payload.pay_address !== 'string' || !payload.pay_address.trim() || payload.pay_address.length > 512
    || (typeof amount !== 'string' && typeof amount !== 'number') || !/^\d+(?:\.\d+)?$/.test(String(amount)) || Number(amount) <= 0
    || typeof payload.pay_currency !== 'string' || payload.pay_currency.toLowerCase() !== config.NOWPAYMENTS_PAY_CURRENCY
    || !new Decimal(String(amount)).eq(order.amount)) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'NOWPayments could not create a usable invoice');
  }

  const suppliedExpiry = typeof payload.expiration_estimate_date === 'string' ? Date.parse(payload.expiration_estimate_date) : NaN;
  const expiresAt = new Date(Number.isFinite(suppliedExpiry) ? suppliedExpiry : Date.now() + 20 * 60_000);
  if (expiresAt.getTime() <= Date.now()) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment processor returned an expired invoice');

  return {
    externalId: String(payload.payment_id),
    checkoutUrl: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}`,
    expiresAt,
    metadata: {
      payAddress: payload.pay_address,
      payAmount: amount,
      payCurrency: payload.pay_currency,
      network: 'TON',
      asset: 'USDT',
      providerPriceCurrency: 'usd',
      providerPriceAmount: referenceAmount.toString(),
      payinExtraId: payload.payin_extra_id,
      expirationEstimateDate: expiresAt.toISOString(),
    },
  };
}

export function parseStripeWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  if (!stripe || !config.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Stripe webhook is not configured');
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid Stripe webhook signature');
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

export function canonicalWebhookPayload(value: Record<string, unknown>): string {
  return JSON.stringify(sortJson(value));
}

export function verifyNowPaymentsWebhook(payload: Record<string, unknown>, signature: string): void {
  if (!config.NOWPAYMENTS_IPN_SECRET) {
    throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'NOWPayments webhook is not configured');
  }
  if (!/^[a-f0-9]{128}$/i.test(signature)) throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid NOWPayments webhook signature');
  const expected = createHmac('sha512', config.NOWPAYMENTS_IPN_SECRET)
    .update(canonicalWebhookPayload(payload))
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid NOWPayments webhook signature');
  }
}
