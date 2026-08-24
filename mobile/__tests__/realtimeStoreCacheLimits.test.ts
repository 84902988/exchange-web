import {
  SPOT_REALTIME_STORE_CACHE_LIMIT,
  __resetSpotMarketRealtimeStoresForTests,
  getSpotMarketRealtimeStore,
} from '../src/realtime/spotMarketRealtime';
import {
  CONTRACT_MARKET_REALTIME_STORE_CACHE_LIMIT,
  __resetContractMarketRealtimeStoresForTests,
  getContractMarketRealtimeStore,
} from '../src/realtime/contractMarketRealtime';
import {
  CONTRACT_KLINE_REALTIME_STORE_CACHE_LIMIT,
  __resetContractKlineRealtimeStoresForTests,
  getContractKlineRealtimeStore,
} from '../src/realtime/contractKlineRealtime';

afterEach(() => {
  __resetContractKlineRealtimeStoresForTests();
  __resetContractMarketRealtimeStoresForTests();
  __resetSpotMarketRealtimeStoresForTests();
});

describe('realtime store cache limits', () => {
  it('bounds inactive spot stores', () => {
    const first = getSpotMarketRealtimeStore('SPOT0USDT');
    for (let index = 1; index <= SPOT_REALTIME_STORE_CACHE_LIMIT; index += 1) {
      getSpotMarketRealtimeStore(`SPOT${index}USDT`);
    }

    expect(getSpotMarketRealtimeStore('SPOT0USDT')).not.toBe(first);
  });

  it('bounds inactive contract market stores', () => {
    const first = getContractMarketRealtimeStore('PERP0USDT');
    for (
      let index = 1;
      index <= CONTRACT_MARKET_REALTIME_STORE_CACHE_LIMIT;
      index += 1
    ) {
      getContractMarketRealtimeStore(`PERP${index}USDT`);
    }

    expect(getContractMarketRealtimeStore('PERP0USDT')).not.toBe(first);
  });

  it('bounds inactive contract Kline symbol/interval stores', () => {
    const first = getContractKlineRealtimeStore('KLINE0USDT', '1m');
    for (
      let index = 1;
      index <= CONTRACT_KLINE_REALTIME_STORE_CACHE_LIMIT;
      index += 1
    ) {
      getContractKlineRealtimeStore(`KLINE${index}USDT`, '1m');
    }

    expect(getContractKlineRealtimeStore('KLINE0USDT', '1m')).not.toBe(first);
  });
});
