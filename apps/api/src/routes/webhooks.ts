import { Decimal } from 'decimal.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { paymentEvents } from '../observability/metrics.js';
import { markOrderPaid, tryFulfillPaidOrder } from '../services/orders.js';
import { parseStripeWebhook, verifyNowPaymentsWebhook, type PaymentProviderName } from '../services/payments.js';
import { getYooKassaPayment } from '../services/yookassa.js';

interface PaymentOrder {
  status: string;
  externalId: string | null;
  currency: string;
  amount: string;
  metadata: Record<string, unknown>;
}

interface PaymentConfirmation {
  orderId: string;
  externalId: string;
  amount: Decimal;
  currency: string;
  crypto?: { paid: Decimal; currency: string };
  verifiedYooKassa?: { testPayment: boolean };
}

const uuid = z.string().uuid();
const paymentMismatch = () => new AppError(400, 'PAYMENT_MISMATCH', 'Payment ID, currency, or amount does not match the order');

function decimal(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^\d+(?:\.\d+)?$/.test(String(value)) || String(value).length > 40) return null;
  return new Decimal(value);
}

async function processEvent(
  provider: Exclude<PaymentProviderName, 'mock'>,
  eventId: string,
  eventType: string,
  confirmation: PaymentConfirmation | null,
): Promise<boolean> {
  const status = confirmation ? 'PROCESSED' : 'IGNORED';
  const processed = await sql.begin(async (transaction) => {
    // Recording a verified event and transitioning its order must commit together.
    // Keep only the metadata needed to reconcile a delivery, not the provider's raw payload.
    const claimed = await transaction<{ id: string }[]>`
      INSERT INTO payment_events (provider, event_id, status, payload, processed_at)
      VALUES (${provider}, ${eventId}, ${status}, ${sql.json({
        type: eventType, orderId: confirmation?.orderId ?? null, externalId: confirmation?.externalId ?? null,
      })}, now())
      ON CONFLICT (provider, event_id) DO UPDATE SET status = EXCLUDED.status,
        payload = EXCLUDED.payload, processed_at = now(), error = NULL
      WHERE payment_events.status IN ('FAILED', 'RECEIVED')
      RETURNING id
    `;
    if (claimed.length === 0) return { processed: false, fulfill: false };
    if (!confirmation) return { processed: true, fulfill: false };

    const [order] = await transaction<PaymentOrder[]>`
      SELECT status, external_id, currency, amount::text, metadata
      FROM orders WHERE id = ${confirmation.orderId} AND payment_provider = ${provider} FOR UPDATE
    `;
    if (!order) throw paymentMismatch();
    const recovery = provider === 'yookassa' ? confirmation.verifiedYooKassa : undefined;
    if (!order.externalId && !recovery) throw new AppError(503, 'CHECKOUT_NOT_RECORDED', 'Checkout is not recorded yet; retry this event');
    const providerCurrency = String(order.metadata.providerPriceCurrency ?? order.currency).toLowerCase();
    const providerAmount = decimal(order.metadata.providerPriceAmount ?? order.amount);
    if ((order.externalId && order.externalId !== confirmation.externalId) || providerCurrency !== confirmation.currency
      || !providerAmount || !confirmation.amount.eq(providerAmount)) throw paymentMismatch();
    if (confirmation.crypto) {
      const expected = decimal(order.metadata.payAmount);
      if (!expected || expected.lte(0) || confirmation.crypto.paid.lt(expected)
        || confirmation.crypto.currency !== String(order.metadata.payCurrency ?? '').toLowerCase()) {
        throw paymentMismatch();
      }
    }
    if (!order.externalId && recovery) {
      // An invoice can be created before a network/DB failure loses its response.
      // Only an authenticated YooKassa GET may recover its ID, after checking the
      // shop, mode, metadata, currency and amount. The incoming notice is not proof.
      await transaction`UPDATE orders SET external_id = ${confirmation.externalId},
        metadata = metadata || ${sql.json({ testPayment: recovery.testPayment })}, updated_at = now()
        WHERE id = ${confirmation.orderId}`;
    }
    // A delayed confirmation must not re-open an order already refunded.
    if (order.status === 'REFUNDED') return { processed: true, fulfill: false };
    await markOrderPaid(confirmation.orderId, transaction);
    return { processed: true, fulfill: order.status !== 'FULFILLED' };
  });
  if (processed.processed) paymentEvents.inc({ provider, status: status.toLowerCase() });
  if (processed.fulfill && confirmation) await tryFulfillPaidOrder(confirmation.orderId);
  return processed.processed;
}

const payableStripeEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/yookassa', async request => {
    const notice = z.object({ type: z.literal('notification'), event: z.string(), object: z.object({ id: z.string().uuid() }) }).parse(request.body);
    // Treat the webhook as a hint. Only our authenticated GET supplies payment facts.
    const payment = await getYooKassaPayment(notice.object.id);
    if (notice.event !== 'payment.succeeded' || payment.status !== 'succeeded' || !payment.paid) return { received: true };
    const processed = await processEvent('yookassa', `${payment.id}:succeeded`, 'payment.succeeded', {
      orderId: payment.metadata.orderId, externalId: payment.id,
      currency: payment.amount.currency.toLowerCase(), amount: new Decimal(payment.amount.value),
      verifiedYooKassa: { testPayment: payment.test },
    });
    return { received: true, ...(!processed && { duplicate: true }) };
  });
  app.post('/api/webhooks/stripe', { config: { rawBody: true } }, async (request) => {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || !request.rawBody) throw new AppError(400, 'INVALID_WEBHOOK', 'Missing Stripe signature or raw body');
    const event = parseStripeWebhook(Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.from(request.rawBody), signature);
    let confirmation: PaymentConfirmation | null = null;
    if (payableStripeEvents.has(event.type)) {
      const session = event.data.object as { id: string; mode: string; payment_status: string;
        metadata?: Record<string, string>; client_reference_id?: string; amount_total: number | null; currency: string | null };
      if (session.payment_status === 'paid') {
        const orderId = session.metadata?.orderId ?? session.client_reference_id;
        if (!uuid.safeParse(orderId).success || session.mode !== 'payment' || !session.id || !session.currency
          || session.amount_total === null || !Number.isSafeInteger(session.amount_total) || session.amount_total <= 0) throw paymentMismatch();
        confirmation = {
          orderId: orderId!, externalId: session.id, currency: session.currency.toLowerCase(),
          amount: new Decimal(session.amount_total).div(100),
        };
      }
    }
    const processed = await processEvent('stripe', event.id, event.type, confirmation);
    return { received: true, ...(!processed && { duplicate: true }) };
  });

  app.post('/api/webhooks/nowpayments', async (request) => {
    const signature = request.headers['x-nowpayments-sig'];
    if (typeof signature !== 'string') throw new AppError(400, 'INVALID_WEBHOOK', 'Missing NOWPayments signature');
    const payload = z.record(z.string(), z.unknown()).parse(request.body);
    verifyNowPaymentsWebhook(payload, signature);
    const paymentId = String(payload.payment_id ?? '');
    const paymentStatus = String(payload.payment_status ?? '');
    if (!/^\d{1,35}$/.test(paymentId) || !/^[a-z_]{1,40}$/.test(paymentStatus)) {
      throw new AppError(400, 'INVALID_WEBHOOK', 'NOWPayments payload is incomplete');
    }
    let confirmation: PaymentConfirmation | null = null;
    if (paymentStatus === 'finished') {
      const orderId = uuid.safeParse(payload.order_id);
      const amount = decimal(payload.price_amount);
      const paid = decimal(payload.actually_paid);
      if (!orderId.success || !amount || !paid || typeof payload.price_currency !== 'string' || typeof payload.pay_currency !== 'string') {
        throw paymentMismatch();
      }
      confirmation = {
        orderId: orderId.data, externalId: paymentId, amount, currency: payload.price_currency.toLowerCase(),
        crypto: { paid, currency: payload.pay_currency.toLowerCase() },
      };
    }
    const processed = await processEvent('nowpayments', `${paymentId}:${paymentStatus}`, paymentStatus, confirmation);
    return { received: true, ...(!processed && { duplicate: true }) };
  });
}
