import { describe, expect, it } from '@jest/globals';
import { contractMarketStore } from '../../lib/realtime/contractMarketStore';
import {
  activateContractMarketShadowSymbol,
  hydrateContractMarketViewShadow,
  selectContractHeaderStoreSnapshot,
  writeContractMarketShadowDomain,
} from './hooks/contractMarketStoreAdapter';

function selectHeader(symbol: string) {
  return selectContractHeaderStoreSnapshot(contractMarketStore.getState(), symbol);
}

describe('Contract Header realtime store adapter', () => {
  it('isolates Header reads across a symbol switch and rejects the retired symbol', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '64000',
        provider_event_time_ms: 1_720_000_000_100,
      },
      transport: 'WS',
    });
    expect(selectHeader('BTCUSDT_PERP')?.displayPrice).toBe('64000');

    activateContractMarketShadowSymbol('ETHUSDT_PERP');
    const retiredResult = writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '65000',
        provider_event_time_ms: 1_720_000_000_200,
      },
      transport: 'WS',
    });
    writeContractMarketShadowDomain({
      symbol: 'ETHUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '3500',
        provider_event_time_ms: 1_720_000_000_200,
      },
      transport: 'WS',
    });

    expect(retiredResult).toMatchObject({ accepted: false, reason: 'OLD_SYMBOL' });
    expect(selectHeader('ETHUSDT_PERP')?.displayPrice).toBe('3500');
  });

  it('keeps the accepted Header snapshot when a stale event arrives', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '64000',
        provider: 'BINANCE_USDM',
        provider_event_time_ms: 1_720_000_000_200,
      },
      transport: 'WS',
    });
    const staleResult = writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '63000',
        provider: 'BINANCE_USDM',
        provider_event_time_ms: 1_720_000_000_100,
      },
      transport: 'WS',
    });

    expect(staleResult).toMatchObject({ accepted: false, reason: 'STALE_EVENT' });
    expect(selectHeader('BTCUSDT_PERP')?.displayPrice).toBe('64000');
  });

  it('accepts a new provider generation and rejects its rollback', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '64000',
        provider: 'BINANCE_USDM',
        provider_generation: 10,
        revision: { epoch: 10, sequence: 5 },
        provider_event_time_ms: 1_720_000_000_200,
      },
      transport: 'WS',
    });
    const newGeneration = writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '64100',
        provider: 'BINANCE_USDM',
        provider_generation: 11,
        revision: { epoch: 11, sequence: 1 },
        provider_event_time_ms: 1_720_000_000_100,
      },
      transport: 'WS',
    });
    const rollback = writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '65000',
        provider: 'BINANCE_USDM',
        provider_generation: 10,
        revision: { epoch: 10, sequence: 99 },
        provider_event_time_ms: 1_720_000_000_300,
      },
      transport: 'WS',
    });

    expect(newGeneration).toMatchObject({ accepted: true, reason: 'NEW_GENERATION' });
    expect(rollback).toMatchObject({ accepted: false, reason: 'GENERATION_ROLLBACK' });
    expect(selectHeader('BTCUSDT_PERP')).toMatchObject({
      displayPrice: '64100',
      providerGeneration: 11,
      revision: { epoch: 11, sequence: 1 },
    });
  });

  it('keeps MarketView display, mark, and index prices consistent in Header projection', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    const results = hydrateContractMarketViewShadow({
      symbol: 'BTCUSDT_PERP',
      display_price: '64000.5',
      display_price_source: 'LIVE_MID',
      mark_price: '64000.1',
      index_price: '63999.9',
      ticker_source: 'LIVE_WS',
      ticker_freshness: 'LIVE',
      executable: true,
      ticker: {
        last_price: '64000.4',
        mark_price: '63900',
        index_price: '63800',
        funding_rate: '0.0001',
        bid: '64000',
        ask: '64001',
      },
      snapshot_metadata: {
        ticker: {
          provider: 'BINANCE_USDM',
          freshness: 'LIVE',
          provider_generation: 12,
          revision: { epoch: 12, sequence: 8 },
          provider_event_time_ms: 1_720_000_000_200,
        },
      },
    }, 'WS');

    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
    expect(selectHeader('BTCUSDT_PERP')).toMatchObject({
      displayPrice: '64000.5',
      displayPriceSource: 'LIVE_MID',
      markPrice: '64000.1',
      indexPrice: '63999.9',
      fundingRate: '0.0001',
      providerGeneration: 12,
    });
  });
});
