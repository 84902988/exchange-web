import { describe, expect, it } from '@jest/globals';
import {
  getContractTickerDomainStatusLabel,
  getContractTickerSourceLabel,
} from './contractMarketSourceStatus';
import { parseContractMarketTimestamp } from './contractMarketTimestamp';

const labels: Record<string, string> = {
  marketSourceRealtime: 'Real-time',
  marketSourceSnapshot: 'Snapshot',
  marketSourceFallback: 'Fallback',
  marketSourceDelayed: 'Delayed',
  marketSourceUnavailable: 'Unavailable',
  tickerSourceStatus: 'Ticker source',
  lastQuoteLabel: 'Last quote',
  klineLatestPrice: 'Kline latest price',
};

const t = (key: string) => labels[key] || key;

describe('authoritative contract ticker status', () => {
  it('shows realtime only for an open executable live ticker', () => {
    expect(getContractTickerSourceLabel({
      source: 'LIVE_WS',
      freshness: 'LIVE',
      marketStatus: 'OPEN',
      executable: true,
      t,
    })).toBe('Real-time');
  });

  it.each([
    { marketStatus: 'CLOSED', source: 'LAST_GOOD_BBO', freshness: 'LAST_VALID' },
    { marketStatus: 'HOLIDAY', source: 'LIVE_WS', freshness: 'LIVE' },
    { marketStatus: 'OPEN', source: 'LIVE_WS', freshness: 'LIVE', executable: false },
    { marketStatus: 'OPEN', source: 'REST', freshness: 'STALE' },
  ])('does not present a non-live ticker as realtime: %o', (status) => {
    const label = getContractTickerSourceLabel({ ...status, t });
    expect(label).not.toBe('Real-time');
  });

  it('labels Kline close as a reference price rather than realtime', () => {
    expect(getContractTickerDomainStatusLabel({
      source: 'KLINE_CLOSE',
      freshness: 'LAST_VALID',
      marketStatus: 'CLOSED',
      executable: false,
      t,
    })).toBe('Ticker source: Kline latest price');
  });
});

describe('contract market timestamps', () => {
  it('keeps a missing or invalid provider timestamp null', () => {
    expect(parseContractMarketTimestamp(null)).toBeNull();
    expect(parseContractMarketTimestamp('')).toBeNull();
    expect(parseContractMarketTimestamp('not-a-time')).toBeNull();
  });

  it('normalizes real provider timestamps without synthesizing the browser time', () => {
    expect(parseContractMarketTimestamp(1_720_000_000)).toBe(1_720_000_000_000);
    expect(parseContractMarketTimestamp('2024-07-03T09:46:40.000Z')).toBe(1_720_000_000_000);
  });
});
