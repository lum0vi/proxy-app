import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalWebhookPayload, createCheckout, verifyNowPaymentsWebhook } from './payments.js';

describe('NOWPayments webhook verification', () => {
  it('canonicalizes nested object keys recursively', () => {
    expect(canonicalWebhookPayload({ z: 1, nested: { y: 2, a: 3 }, a: [2, { z: 1, a: 0 }] }))
      .toBe('{"a":[2,{"a":0,"z":1}],"nested":{"a":3,"y":2},"z":1}');
  });

  it('accepts only an HMAC for the canonical payload', () => {
    const payload = { payment_status: 'finished', order_id: 'order-1', nested: { b: 2, a: 1 } };
    const signature = createHmac('sha512', 'test-nowpayments-ipn-secret')
      .update(canonicalWebhookPayload(payload))
      .digest('hex');

    expect(() => verifyNowPaymentsWebhook(payload, signature)).not.toThrow();
    expect(() => verifyNowPaymentsWebhook(payload, '00'.repeat(64))).toThrow('Invalid NOWPayments webhook signature');
  });
});

describe('TON checkout', () => {
  it('uses the exact invoice for TON, keeps its memo and deadline, and rejects another coin', async () => {
    const expiresAt = new Date(Date.now() + 20 * 60_000);
    const order = { id: 'test-order', amount: '20.00', currency: 'USD', productName: 'Test key', userEmail: 'payment@example.test', reservedUntil: expiresAt };
    const invoice = { payment_id: 123, pay_address: 'test-address', pay_amount: '18.235', pay_currency: 'ton', payin_extra_id: '0123', expiration_estimate_date: expiresAt.toISOString() };
    const fetchInvoice = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(invoice))
      .mockResolvedValueOnce(Response.json({ ...invoice, pay_currency: 'usdtton' }));
    vi.stubGlobal('fetch', fetchInvoice);
    try {
      const checkout = await createCheckout('nowpayments', order);
      const [url, request] = fetchInvoice.mock.calls[0]!;
      expect(url).toBe('https://nowpayments.invalid/v1/payment');
      expect(JSON.parse(String(request?.body))).toMatchObject({ price_amount: 20, price_currency: 'usd', pay_currency: 'ton', is_fixed_rate: true });
      expect(checkout).toMatchObject({ externalId: '123', expiresAt, metadata: { payAddress: 'test-address', payAmount: '18.235', network: 'TON', payinExtraId: '0123' } });
      await expect(createCheckout('nowpayments', order)).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
    } finally { vi.unstubAllGlobals(); }
  });
});
