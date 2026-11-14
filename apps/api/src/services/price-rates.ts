import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';

const ratesSchema = z.object({
  rates: z.object({ TON: z.object({ prices: z.object({ USD: z.number().positive(), RUB: z.number().positive() }) }) }),
});

interface PriceRates {
  usdToRub: string;
  usdToTon: string;
  checkedAt: string;
}

const refreshIntervalMs = 10 * 60_000;
const maxAgeMs = 60 * 60_000;
let cached: { rates: PriceRates; checkedAt: number } | undefined;
let inFlight: Promise<PriceRates | null> | undefined;
let retryAt = 0;

function fallback() {
  return cached && Date.now() - cached.checkedAt < maxAgeMs ? cached.rates : null;
}

async function refresh(): Promise<PriceRates | null> {
  try {
    const response = await fetch(config.PRICE_RATES_URL, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return fallback();
    const { USD, RUB } = ratesSchema.parse(await response.json()).rates.TON.prices;
    const checkedAt = Date.now();
    const rates = {
      usdToRub: new Decimal(RUB).div(USD).toFixed(8),
      usdToTon: new Decimal(1).div(USD).toFixed(8),
      checkedAt: new Date(checkedAt).toISOString(),
    };
    cached = { rates, checkedAt };
    return rates;
  } catch {
    return fallback();
  }
}

export async function getPriceRates(): Promise<PriceRates | null> {
  if (cached && Date.now() - cached.checkedAt < refreshIntervalMs) return cached.rates;
  if (inFlight) return inFlight;
  if (Date.now() < retryAt) return fallback();
  retryAt = Date.now() + 60_000;
  inFlight = refresh().finally(() => { inFlight = undefined; });
  return inFlight;
}
