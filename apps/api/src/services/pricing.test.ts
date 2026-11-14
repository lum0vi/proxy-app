import { describe, expect, it } from 'vitest';
import { calculateUsageCost, moneyString, retailPrice } from './pricing.js';

describe('pricing', () => {
  it('accepts a fractional retail markup without floating-point drift', () => {
    expect(retailPrice('10', '1.75').toFixed(2)).toBe('17.50');
    expect(retailPrice('0.10', '2.15').toFixed(2)).toBe('0.22');
    expect(moneyString('19.999')).toBe('20.00');
  });

  it('charges cached input once at the cached rate', () => {
    const cost = calculateUsageCost({
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 100_000,
      imageCount: 0,
      inputPerMillion: '1',
      cachedInputPerMillion: '0.1',
      outputPerMillion: '2',
      perRequest: '0',
    });

    expect(cost.toFixed(8)).toBe('0.84000000');
  });

  it('never subtracts more cached tokens than total input tokens', () => {
    const cost = calculateUsageCost({
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 0,
      imageCount: 3,
      inputPerMillion: '1',
      cachedInputPerMillion: '0.1',
      outputPerMillion: '2',
      perRequest: '0.015',
    });

    expect(cost.toFixed(8)).toBe('0.04501000');
  });

  it('applies a configurable long-context multiplier to token cost only', () => {
    const cost = calculateUsageCost({
      inputTokens: 300_000,
      cachedInputTokens: 0,
      outputTokens: 100_000,
      imageCount: 1,
      inputPerMillion: '1',
      cachedInputPerMillion: '0.1',
      outputPerMillion: '2',
      perRequest: '0.015',
      longContextThreshold: 272_000,
      longContextMultiplier: '2',
    });

    expect(cost.toFixed(8)).toBe('1.01500000');
  });
});
