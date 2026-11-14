import { Decimal } from 'decimal.js';
import { config } from '../config.js';

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export function retailPrice(wholesaleCredits: Decimal.Value, markup: Decimal.Value = config.PRICE_MARKUP): Decimal {
  return new Decimal(wholesaleCredits).mul(markup).toDecimalPlaces(2);
}

export function moneyString(value: Decimal.Value, decimals = 2): string {
  return new Decimal(value).toDecimalPlaces(decimals).toFixed(decimals);
}

export function retailMultiplier(amount: Decimal.Value, wholesaleAllowance: Decimal.Value): Decimal {
  return new Decimal(amount).div(wholesaleAllowance);
}

export function retailUsageCost(cost: Decimal.Value, multiplier: Decimal.Value) {
  return new Decimal(cost).mul(multiplier).toDecimalPlaces(8);
}

export function activePeakMultiplier(multiplier: string | number, at = new Date()) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? multiplier : 1;
}

export function calculateUsageCost(input: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  imageCount: number;
  requestCount?: number;
  inputPerMillion: Decimal.Value;
  outputPerMillion: Decimal.Value;
  cachedInputPerMillion: Decimal.Value;
  perRequest: Decimal.Value;
  longContextThreshold?: number | null;
  longContextMultiplier?: Decimal.Value;
  peakMultiplier?: Decimal.Value;
}): Decimal {
  const million = new Decimal(1_000_000);
  const cachedInputTokens = Decimal.min(input.cachedInputTokens, input.inputTokens);
  const inputBeforeWrites = Decimal.max(new Decimal(input.inputTokens).sub(cachedInputTokens), 0);
  const writesHour = Decimal.min(inputBeforeWrites, input.cacheWrite1hTokens ?? 0);
  const writesShort = Decimal.min(inputBeforeWrites.sub(writesHour), input.cacheWrite5mTokens ?? 0);
  const uncachedInputTokens = inputBeforeWrites.sub(writesHour).sub(writesShort);
  let tokenCost = uncachedInputTokens
    .add(writesShort.mul('1.25')).add(writesHour.mul(2))
    .mul(input.inputPerMillion)
    .div(million)
    .add(new Decimal(input.outputTokens).mul(input.outputPerMillion).div(million))
    .add(cachedInputTokens.mul(input.cachedInputPerMillion).div(million));
  if (input.longContextThreshold && input.inputTokens > input.longContextThreshold) {
    tokenCost = tokenCost.mul(input.longContextMultiplier ?? 1);
  }
  return tokenCost.mul(input.peakMultiplier ?? 1)
    .add(new Decimal(input.requestCount ?? (input.imageCount || 1)).mul(input.perRequest));
}
