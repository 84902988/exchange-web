import { describe, expect, it } from '@jest/globals';
import type { ContractQuote } from '@/lib/api/modules/contract';
import { mergeContractQuoteIncrement } from './contractQuoteIncrement';

function quote(overrides: Partial<ContractQuote> = {}): ContractQuote {
  return {
    symbol: 'EURUSD_PERP',
    provider: 'ITICK',
    provider_symbol: 'EURUSD',
    bid_price: '1.14210',
    ask_price: '1.14225',
    last_price: '1.14219',
    mark_price: '1.14219',
    source: 'LIVE_WS',
    ts: '2026-07-21T08:30:00Z',
    ...overrides,
  };
}

describe('mergeContractQuoteIncrement', () => {
  it('keeps REST ticker evidence when a price-only WS frame omits it', () => {
    const previous = quote({
      market_status: 'OPEN',
      price_change_24h: '0.00075',
      price_change_percent_24h: '0.065704',
      high_24h: '1.14278',
      low_24h: '1.14088',
      base_volume_24h: '259978.6',
      quote_volume_24h: '296805.11612',
    });
    const incoming = quote({
      bid_price: '1.14220',
      ask_price: '1.14235',
      last_price: '1.14227',
      price_change_24h: null,
      price_change_percent_24h: undefined,
      high_24h: '',
      low_24h: null,
      base_volume_24h: null,
      quote_volume_24h: null,
    });

    expect(mergeContractQuoteIncrement(previous, incoming)).toMatchObject({
      bid_price: '1.14220',
      ask_price: '1.14235',
      last_price: '1.14227',
      market_status: 'OPEN',
      price_change_24h: '0.00075',
      price_change_percent_24h: '0.065704',
      high_24h: '1.14278',
      low_24h: '1.14088',
      base_volume_24h: '259978.6',
      quote_volume_24h: '296805.11612',
    });
  });

  it('accepts genuine zero and false values from a newer frame', () => {
    const previous = quote({
      price_change_24h: '1',
      price_change_percent_24h: '2',
      executable: true,
      stale: true,
    });
    const incoming = quote({
      price_change_24h: 0,
      price_change_percent_24h: 0,
      executable: false,
      stale: false,
    });

    expect(mergeContractQuoteIncrement(previous, incoming)).toMatchObject({
      price_change_24h: 0,
      price_change_percent_24h: 0,
      executable: false,
      stale: false,
    });
  });
});
