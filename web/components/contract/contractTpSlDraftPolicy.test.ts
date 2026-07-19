import { describe, expect, it } from '@jest/globals';

import {
  buildContractTpSlDraftPrices,
  refreshContractTpSlRecommendations,
  validateContractTpSlPrices,
} from './contractTpSlDraftPolicy';

describe('contractTpSlDraftPolicy', () => {
  it('preserves valid existing prices and identifies generated recommendations', () => {
    expect(buildContractTpSlDraftPrices({
      side: 'LONG',
      referencePrice: '100',
      entryPrice: '90',
      takeProfitPrice: '110',
      stopLossPrice: null,
      pricePrecision: 2,
    })).toEqual({
      takeProfit: { value: '110.00', origin: 'EXISTING' },
      stopLoss: { value: '99.80', origin: 'RECOMMENDED' },
    });
  });

  it('refreshes only an untouched recommendation when the live reference crosses it', () => {
    const initial = buildContractTpSlDraftPrices({
      side: 'LONG',
      referencePrice: '100',
      entryPrice: '90',
      takeProfitPrice: null,
      stopLossPrice: null,
      pricePrecision: 2,
    });
    const refreshed = refreshContractTpSlRecommendations({
      side: 'LONG',
      referencePrice: '101',
      prices: {
        takeProfit: initial.takeProfit,
        stopLoss: { value: '97.50', origin: 'USER' },
      },
      pricePrecision: 2,
    });

    expect(refreshed.takeProfit).toEqual({ value: '101.20', origin: 'RECOMMENDED' });
    expect(refreshed.stopLoss).toEqual({ value: '97.50', origin: 'USER' });
  });

  it('validates against the configured trigger reference without calling it mark price', () => {
    expect(validateContractTpSlPrices({
      side: 'LONG',
      referencePrice: '105',
      takeProfitPrice: '104',
      stopLossPrice: '95',
    })).toBe('LONG_TP_MUST_BE_ABOVE_REFERENCE');
    expect(validateContractTpSlPrices({
      side: 'SHORT',
      referencePrice: '105',
      takeProfitPrice: '100',
      stopLossPrice: '104',
    })).toBe('SHORT_SL_MUST_BE_ABOVE_REFERENCE');
  });
});
