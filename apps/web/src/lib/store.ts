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

export type PaymentMethod = 'stripe' | 'nowpayments' | 'mock';

export interface StoreCatalog {
  products: Product[];
  paymentMethods: PaymentMethod[];
  cryptoCurrency: string | null;
}

export interface PriceRates {
  usdToRub: string;
  usdToTon: string;
  checkedAt: string;
}

export function ton(value: number, locale: Locale) {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value)} TON`;
}

export interface CustomerKey {
  id: string;
  label: string;
  keyHint: string;
  status: string;
  creditsTotal: string;
  creditsUsed: string;
  concurrencyLimit: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  models: string[];
  modelOptions: ModelOption[];
}

export function money(value: string | number, locale: Locale, currency = 'USD', maximumFractionDigits = 2) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits }).format(Number(value));
}

export function concurrentRequestSummary(limit: number, locale: Locale) {
  if (locale === 'en') return `Up to ${limit} model ${limit === 1 ? 'request' : 'requests'} at once per key`;
  const requests = new Intl.PluralRules(locale).select(limit) === 'one' ? 'запроса' : 'запросов';
  return `До ${limit} ${requests} одновременно с одним ключом`;
}
