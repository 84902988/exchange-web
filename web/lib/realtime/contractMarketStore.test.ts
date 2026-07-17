import { describe, expect, it } from '@jest/globals';
import {
  buildContractMarketStoreKey,
  contractMarketStore,
  createContractMarketStore,
  selectContractMarketKlineEntry,
  subscribeContractMarketKlineEntry,
} from './contractMarketStore';

describe('ContractMarketStore', () => {
  it('rejects an old-symbol event after the active symbol changes', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    expect(store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '64000' },
      transport: 'WS',
      eventTimeMs: 1_720_000_000_100,
    }).accepted).toBe(true);

    store.activateSymbol('ETHUSDT_PERP');
    const result = store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '64001' },
      transport: 'WS',
      eventTimeMs: 1_720_000_000_200,
    });

    expect(result).toMatchObject({ accepted: false, reason: 'OLD_SYMBOL' });
    expect(store.getEntry<{ last_price: string }>('BTCUSDT_PERP', 'ticker')?.data.last_price)
      .toBe('64000');
  });

  it('rejects an event older than the accepted domain snapshot', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'depth',
      data: { sequence: 20 },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      eventTimeMs: 1_720_000_000_200,
    });

    const result = store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'depth',
      data: { sequence: 19 },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      eventTimeMs: 1_720_000_000_100,
    });

    expect(result).toMatchObject({ accepted: false, reason: 'STALE_EVENT' });
    expect(store.getEntry<{ sequence: number }>('BTCUSDT_PERP', 'depth')?.data.sequence)
      .toBe(20);
  });

  it('rejects a provider generation rollback even when it arrives later', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '64000' },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 8,
      eventTimeMs: 1_720_000_000_100,
    });

    const result = store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '65000' },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 7,
      eventTimeMs: 1_720_000_000_300,
    });

    expect(result).toMatchObject({ accepted: false, reason: 'GENERATION_ROLLBACK' });
    expect(store.getEntry('BTCUSDT_PERP', 'ticker')?.providerGeneration).toBe(8);
  });

  it('does not revive the previous session when returning to the same symbol', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '64000' },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 8,
      eventTimeMs: 1_720_000_000_200,
    });

    store.activateSymbol('ETHUSDT_PERP');
    store.activateSymbol('BTCUSDT_PERP');
    const result = store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '63900' },
      transport: 'REST',
      provider: 'BINANCE_USDM',
      providerGeneration: 7,
      eventTimeMs: 1_720_000_000_100,
    });

    expect(result.accepted).toBe(true);
    expect(store.getEntry<{ last_price: string }>('BTCUSDT_PERP', 'ticker'))
      .toMatchObject({
        sessionGeneration: store.getState().sessionGeneration,
        providerGeneration: 7,
        data: { last_price: '63900' },
      });
  });

  it('isolates kline authority by symbol and interval', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '1m',
      data: { close: '64000' },
      transport: 'REST',
      eventTimeMs: 1_720_000_000_100,
    });
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '1M',
      data: { close: '62000' },
      transport: 'REST',
      eventTimeMs: 1_720_000_000_100,
    });

    expect(buildContractMarketStoreKey('BTCUSDT_PERP', 'kline', '1m'))
      .not.toBe(buildContractMarketStoreKey('BTCUSDT_PERP', 'kline', '1M'));
    expect(store.getEntry<{ close: string }>('BTCUSDT_PERP', 'kline', '1m')?.data.close)
      .toBe('64000');
    expect(store.getEntry<{ close: string }>('BTCUSDT_PERP', 'kline', '1M')?.data.close)
      .toBe('62000');
  });

  it('rejects revision rollback in the same provider generation', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'depth',
      data: { bids: [['64000', '1']] },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 3,
      revision: { epoch: 3, sequence: 22 },
      eventTimeMs: 1_720_000_000_100,
    });

    const result = store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'depth',
      data: { bids: [['63900', '1']] },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 3,
      revision: { epoch: 3, sequence: 21 },
      eventTimeMs: 1_720_000_000_200,
    });

    expect(result).toMatchObject({ accepted: false, reason: 'REVISION_ROLLBACK' });
    expect(store.getEntry<{ bids: string[][] }>('BTCUSDT_PERP', 'depth')?.data.bids[0][0])
      .toBe('64000');
  });

  it('selects and subscribes to kline authority by active symbol and exact interval', () => {
    contractMarketStore.resetForTests();
    contractMarketStore.activateSymbol('BTCUSDT_PERP');
    contractMarketStore.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '1M',
      data: { open_time: 1_720_000_000_000, close: '64000' },
      transport: 'WS',
      eventTimeMs: 1_720_000_000_100,
    });
    let notifications = 0;
    const unsubscribe = subscribeContractMarketKlineEntry(
      'BTCUSDT_PERP',
      '1M',
      () => { notifications += 1; },
    );

    contractMarketStore.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { display_price: '65000' },
      transport: 'WS',
      eventTimeMs: 1_720_000_000_200,
    });
    contractMarketStore.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '5m',
      data: { open_time: 1_720_000_000_000, close: '65000' },
      transport: 'WS',
      eventTimeMs: 1_720_000_000_200,
    });

    expect(notifications).toBe(0);
    expect(selectContractMarketKlineEntry(
      contractMarketStore.getState(),
      'BTCUSDT_PERP',
      '1M',
    )?.data).toMatchObject({ close: '64000' });
    expect(selectContractMarketKlineEntry(
      contractMarketStore.getState(),
      'BTCUSDT_PERP',
      '1m',
    )).toBeNull();

    contractMarketStore.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '1M',
      data: { open_time: 1_720_000_000_000, close: '64001' },
      transport: 'WS',
      eventTimeMs: 1_720_000_000_300,
    });
    expect(notifications).toBe(1);

    contractMarketStore.activateSymbol('ETHUSDT_PERP');
    expect(notifications).toBe(2);
    expect(selectContractMarketKlineEntry(
      contractMarketStore.getState(),
      'BTCUSDT_PERP',
      '1M',
    )).toBeNull();
    unsubscribe();
  });
});
