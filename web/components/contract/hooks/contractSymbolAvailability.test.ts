import { ApiError } from '@/lib/api/core/error';
import { isContractSymbolConfigMissingError } from './useContractMarketState';

describe('contract symbol availability', () => {
  test('keeps the backend disabled-symbol code after user-facing translation', () => {
    expect(isContractSymbolConfigMissingError(
      new ApiError(
        'contract symbol DJIUSDT_PERP not found or disabled',
        'CONTRACT_SYMBOL_NOT_FOUND',
        'trace-disabled',
      ),
    )).toBe(true);
  });

  test('does not classify a transient quote outage as an admin disable', () => {
    expect(isContractSymbolConfigMissingError(
      new ApiError(
        'quote temporarily unavailable',
        'CONTRACT_QUOTE_UNAVAILABLE',
        'trace-quote',
      ),
    )).toBe(false);
  });

  test('recognizes the MarketView disabled-symbol message without an error wrapper', () => {
    expect(isContractSymbolConfigMissingError(
      'contract symbol DJIUSDT_PERP not found or disabled',
    )).toBe(true);
  });
});
