import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { moneyString } from './pricing.js';

export type PaymentProviderName = 'stripe' | 'nowpayments' | 'mock';

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

  if (provider === 'stripe') {
    if (!stripe) throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Stripe is not configured');
    const unitAmount = Number.parseInt(moneyString(order.amount, 2).replace('.', ''), 10);
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        adaptive_pricing: { enabled: false },
        client_reference_id: order.id,
        customer_email: order.userEmail,
        metadata: { orderId: order.id },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: order.currency.toLowerCase(),
              unit_amount: unitAmount,
              product_data: { name: order.productName },
            },
          },
        ],
        success_url: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}?payment=success`,
        cancel_url: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}?payment=cancelled`,
        expires_at: Math.floor(order.reservedUntil.getTime() / 1000),
      },
      { idempotencyKey: `order-${order.id}` },
    );
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { externalId: session.id, checkoutUrl: session.url };
  }

  if (!config.NOWPAYMENTS_API_KEY) {
    throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'NOWPayments is not configured');
  }

  const response = await fetch(`${config.NOWPAYMENTS_API_URL.replace(/\/$/, '')}/payment`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.NOWPAYMENTS_API_KEY,
    },
    body: JSON.stringify({
      price_amount: Number(order.amount),
      price_currency: order.currency.toLowerCase(),
      pay_currency: config.NOWPAYMENTS_PAY_CURRENCY,
      ipn_callback_url: `${config.PUBLIC_APP_URL}/api/webhooks/nowpayments`,
      order_id: order.id,
      order_description: order.productName,
      is_fixed_rate: true,
      is_fee_paid_by_user: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const amount = payload?.pay_amount;
  if (!response.ok || !payload?.payment_id || !payload.pay_address
    || (typeof amount !== 'string' && typeof amount !== 'number') || !/^\d+(?:\.\d+)?$/.test(String(amount)) || Number(amount) <= 0
    || typeof payload.pay_currency !== 'string' || payload.pay_currency.toLowerCase() !== config.NOWPAYMENTS_PAY_CURRENCY) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'NOWPayments could not create a usable invoice');
  }

  const suppliedExpiry = typeof payload.expiration_estimate_date === 'string' ? Date.parse(payload.expiration_estimate_date) : NaN;
  const expiresAt = new Date(Number.isFinite(suppliedExpiry) ? suppliedExpiry : Date.now() + 20 * 60_000);

  return {
    externalId: String(payload.payment_id),
    checkoutUrl: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}`,
    expiresAt,
    metadata: {
      payAddress: payload.pay_address,
      payAmount: amount,
      payCurrency: payload.pay_currency,
      network: payload.network ?? (config.NOWPAYMENTS_PAY_CURRENCY === 'ton' ? 'TON' : null),
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
