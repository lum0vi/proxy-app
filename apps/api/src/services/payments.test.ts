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

describe('USDT on TON checkout', () => {
  it('turns network failures into a retryable error without leaking provider details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private provider connection details')));
    try {
      await expect(createCheckout('nowpayments', { id: 'network-test', amount: '20', currency: 'USDT',
        productName: 'Test key', userEmail: 'test@example.test', reservedUntil: new Date(Date.now() + 100_000) }))
        .rejects.toMatchObject({ statusCode: 503, code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: 'The payment processor is temporarily unavailable' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects malformed or already expired crypto invoices', async () => {
    const order = { id: 'malformed-test', amount: '20', currency: 'USDT', productName: 'Test key',
      userEmail: 'test@example.test', reservedUntil: new Date(Date.now() + 100_000) };
    for (const change of [{ payment_id: 'not-a-payment-id' }, { pay_address: {} }, { expiration_estimate_date: '2000-01-01T00:00:00Z' }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ payment_id: 123, pay_address: 'synthetic',
        pay_amount: '20', pay_currency: 'usdtton', ...change })));
      try { await expect(createCheckout('nowpayments', order)).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' }); }
      finally { vi.unstubAllGlobals(); }
    }
  });

  it('uses an exact USDT amount, keeps its memo and deadline, and rejects another coin or amount', async () => {
    const expiresAt = new Date(Date.now() + 20 * 60_000);
    const order = { id: 'test-order', amount: '20.00', currency: 'USDT', productName: 'Test key', userEmail: 'payment@example.test', reservedUntil: expiresAt };
    const invoice = { payment_id: 123, pay_address: 'test-address', pay_amount: '20', pay_currency: 'usdtton', payin_extra_id: '0123', expiration_estimate_date: expiresAt.toISOString() };
    const fetchInvoice = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(invoice))
      .mockResolvedValueOnce(Response.json({ ...invoice, pay_currency: 'ton' }))
      .mockResolvedValueOnce(Response.json({ ...invoice, pay_amount: '19.99' }));
    vi.stubGlobal('fetch', fetchInvoice);
    try {
      const checkout = await createCheckout('nowpayments', order);
      const [url, request] = fetchInvoice.mock.calls[0]!;
      expect(url).toBe('https://nowpayments.invalid/v1/payment');
      expect(JSON.parse(String(request?.body))).toMatchObject({ price_amount: 20, price_currency: 'usd', pay_amount: 20, pay_currency: 'usdtton', is_fixed_rate: true });
      expect(checkout).toMatchObject({ externalId: '123', expiresAt, metadata: { payAddress: 'test-address', payAmount: '20', asset: 'USDT', network: 'TON', providerPriceCurrency: 'usd', providerPriceAmount: '20', payinExtraId: '0123' } });
      await expect(createCheckout('nowpayments', order)).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
      await expect(createCheckout('nowpayments', order)).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
    } finally { vi.unstubAllGlobals(); }
  });
});
