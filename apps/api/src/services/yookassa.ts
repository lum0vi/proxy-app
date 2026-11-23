import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import type { CheckoutOrder, CheckoutResult } from './payments.js';

const paymentSchema = z.object({
  id: z.string().uuid(), status: z.enum(['pending', 'waiting_for_capture', 'succeeded', 'canceled']),
  paid: z.boolean(), test: z.boolean(),
  amount: z.object({ value: z.string().regex(/^\d+\.\d{2}$/), currency: z.literal('RUB') }),
  recipient: z.object({ account_id: z.string() }),
  metadata: z.object({ orderId: z.string().uuid() }),
  confirmation: z.object({ type: z.string(), confirmation_url: z.string().url().optional() }).optional(),
  expires_at: z.string().optional(),
});

async function requestPayment(path: string, payload?: object, idempotencyKey?: string) {
  if (!config.YOOKASSA_SHOP_ID || !config.YOOKASSA_SECRET_KEY) {
    throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'YooKassa is not configured');
  }
  let response: Response;
  try {
    response = await fetch(`${config.YOOKASSA_API_URL.replace(/\/$/, '')}${path}`, {
      method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Basic ${Buffer.from(`${config.YOOKASSA_SHOP_ID}:${config.YOOKASSA_SECRET_KEY}`).toString('base64')}`,
        'content-type': 'application/json', ...(idempotencyKey && { 'Idempotence-Key': idempotencyKey }) },
      ...(payload && { body: JSON.stringify(payload) }),
    });
  } catch { throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'YooKassa is temporarily unavailable'); }
  const parsed = paymentSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'YooKassa returned an invalid payment');
  const payment = parsed.data;
  if (payment.recipient.account_id !== config.YOOKASSA_SHOP_ID || payment.test !== config.YOOKASSA_TEST_MODE) {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'YooKassa shop or payment mode mismatch');
  }
  return payment;
}

export async function getYooKassaPayment(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new AppError(400, 'INVALID_WEBHOOK', 'Invalid payment ID');
  const payment = await requestPayment(`/payments/${id}`);
  if (payment.id !== id) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Payment ID mismatch');
  return payment;
}

export async function createYooKassaCheckout(order: CheckoutOrder): Promise<CheckoutResult> {
  if (order.currency !== 'RUB') throw new AppError(400, 'INVALID_CURRENCY', 'YooKassa checkout requires RUB');
  const amount = { value: new Decimal(order.amount).toFixed(2), currency: 'RUB' };
  const payment = await requestPayment('/payments', {
    amount, capture: true, description: order.productName.slice(0, 128), metadata: { orderId: order.id },
    confirmation: { type: 'redirect', return_url: `${config.PUBLIC_APP_URL}/dashboard/orders/${order.id}` },
    ...(config.YOOKASSA_RECEIPTS_ENABLED && { receipt: {
      customer: { email: order.userEmail },
      ...(config.YOOKASSA_TAX_SYSTEM_CODE && { tax_system_code: config.YOOKASSA_TAX_SYSTEM_CODE }),
      items: [{ description: order.productName.slice(0, 128), quantity: '1.00', amount,
        vat_code: config.YOOKASSA_VAT_CODE, payment_mode: 'full_payment', payment_subject: 'service' }],
    } }),
  }, order.id);
  const checkoutUrl = payment.confirmation?.confirmation_url;
  if (payment.metadata.orderId !== order.id || !new Decimal(payment.amount.value).eq(order.amount)
    || !checkoutUrl || new URL(checkoutUrl).protocol !== 'https:' || payment.status !== 'pending') {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'YooKassa could not create a usable checkout');
  }
  const deadline = payment.expires_at ? Date.parse(payment.expires_at) : NaN;
  return { externalId: payment.id, checkoutUrl,
    ...(Number.isFinite(deadline) && deadline > Date.now() && { expiresAt: new Date(deadline) }),
    metadata: { testPayment: payment.test },
  };
}
