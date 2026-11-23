import type { Locale } from './preferences';

export type Protocol = 'OPENAI' | 'OPENAI_CHAT' | 'ANTHROPIC' | 'GEMINI' | 'IMAGES';

export interface ModelOption {
  model: string;
  protocol: Protocol;
}

export interface ModelRate extends ModelOption {
  available: boolean;
  inputPerMillion: string;
  cachedInputPerMillion: string;
  outputPerMillion: string;
  perRequest: string;
  longContextThreshold: number | null;
  longContextMultiplier: string;
  peakMultiplier: string;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  usageAllowance: string;
  retailPrice: string;
  currency: string;
  durationDays: number | null;
  concurrencyLimit: number;
  inventory: number;
  models: ModelRate[];
  unpricedModels: ModelOption[];
}

export type PaymentMethod = 'yookassa' | 'nowpayments' | 'mock';
export type PaymentCurrency = 'RUB' | 'USDT';

export interface StoreCatalog {
  products: Product[];
  paymentMethods: PaymentMethod[];
  paymentCurrencies: PaymentCurrency[];
  cryptoCurrency: string | null;
  cryptoNetwork: string | null;
  currency: 'USDT';
}

export interface PriceRates {
  usdtToRub: string;
  checkedAt: string;
  source: 'coingecko' | 'configured';
}

export interface CustomerKey {
  id: string;
  label: string;
  keyHint: string;
  status: string;
  creditsTotal: string;
  creditsUsed: string;
  currency: 'USDT';
  concurrencyLimit: number;
  expiresAt: string | null;
  testKey: boolean;
  topUpProductIds: string[];
  lastUsedAt: string | null;
  createdAt: string;
  models: string[];
  modelOptions: ModelOption[];
}

export function money(value: string | number, locale: Locale, currency = 'USDT', maximumFractionDigits = 2) {
  if (currency === 'USDT') return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits }).format(Number(value))} USDT`;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits }).format(Number(value));
}

export function concurrentRequestSummary(limit: number, locale: Locale) {
  if (locale === 'en') return `Up to ${limit} model ${limit === 1 ? 'request' : 'requests'} at once per key`;
  const requests = new Intl.PluralRules(locale).select(limit) === 'one' ? 'запроса' : 'запросов';
  return `До ${limit} ${requests} одновременно с одним ключом`;
}
