import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { Decimal } from 'decimal.js';
import { createYooKassaCheckout } from './yookassa.js';

export type PaymentProviderName = 'stripe' | 'nowpayments' | 'yookassa' | 'mock';

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

export async function createCheckout(
  provider: PaymentProviderName,
  order: CheckoutOrder,
): Promise<CheckoutResult> {
  if (provider === 'yookassa') return createYooKassaCheckout(order);
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
