import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

export interface PriceRates {
  usdtToRub: string;
  checkedAt: string;
  source: 'coingecko' | 'configured';
}

const schema = z.object({ tether: z.object({ rub: z.number().finite().positive(), last_updated_at: z.number().int().positive() }) });
let cached: PriceRates | null = null;
let inFlight: Promise<PriceRates | null> | undefined;
let retryAt = 0;
const fresh = (rates: PriceRates | null, ageMs: number) => {
  const age = rates ? Date.now() - Date.parse(rates.checkedAt) : NaN;
  return age >= -60_000 && age <= ageMs ? rates : null;
};

export async function getPriceRates(): Promise<PriceRates | null> {
  if (config.USDT_RUB_RATE) return { usdtToRub: new Decimal(config.USDT_RUB_RATE).toFixed(8), checkedAt: new Date().toISOString(), source: 'configured' };
  if (fresh(cached, 5 * 60_000)) return cached;
  if (inFlight) return inFlight;
  if (Date.now() < retryAt) return fresh(cached, 60 * 60_000);
  retryAt = Date.now() + 60_000;
  inFlight = (async () => {
    try {
      const response = await fetch(config.PRICE_RATES_URL, {
        headers: { accept: 'application/json', ...(config.PRICE_RATES_API_KEY && { 'x-cg-demo-api-key': config.PRICE_RATES_API_KEY }) },
        redirect: 'error', signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error('Rate unavailable');
      const rate = schema.parse(await response.json()).tether;
      const checkedAt = rate.last_updated_at * 1000;
      if (checkedAt > Date.now() + 60_000 || Date.now() - checkedAt > 60 * 60_000) throw new Error('Stale exchange rate');
      cached = { usdtToRub: new Decimal(rate.rub).toFixed(8), checkedAt: new Date(checkedAt).toISOString(), source: 'coingecko' };
    } catch { /* A display rate may be cached, but checkout requires a fresh quote. */ }
    return fresh(cached, 60 * 60_000);
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}

export async function requireRubRate(): Promise<PriceRates> {
  const rates = fresh(await getPriceRates(), 15 * 60_000);
  if (!rates) throw new AppError(503, 'EXCHANGE_RATE_UNAVAILABLE', 'RUB checkout is temporarily unavailable. Retry later or pay in USDT');
  return rates;
}
