import { describe, expect, it } from '@jest/globals';
import { formatContractHeaderChange } from './contractHeaderChange';

describe('formatContractHeaderChange', () => {
  it('fails closed when provider change evidence is missing', () => {
    expect(formatContractHeaderChange({
      changeAmount: null,
      changePercent: null,
      pricePrecision: 1,
    })).toBeNull();
  });

  it('preserves a genuine zero change', () => {
    expect(formatContractHeaderChange({
      changeAmount: '0',
      changePercent: '0',
      pricePrecision: 1,
    })).toBe('0.0 / 0.00%');
  });

  it('formats signed positive and negative evidence without coercing null', () => {
    expect(formatContractHeaderChange({
      changeAmount: '12.34',
      changePercent: '1.25',
      pricePrecision: 2,
    })).toBe('+12.34 / +1.25%');
    expect(formatContractHeaderChange({
      changeAmount: '-12.34',
      changePercent: '-1.25',
      pricePrecision: 2,
    })).toBe('-12.34 / -1.25%');
  });
});
