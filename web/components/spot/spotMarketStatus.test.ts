import { describe, expect, it } from '@jest/globals';
import { resolveSpotMarketStatus } from './spotMarketStatus';

describe('spot market status hydration', () => {
  it('shows loading instead of snapshot while the market is hydrating', () => {
    expect(resolveSpotMarketStatus({
      source: 'REST_SNAPSHOT',
      freshness: 'RECENT',
      isHydrating: true,
    }).kind).toBe('loading');
  });

  it('shows loading instead of fallback while the market is hydrating', () => {
    expect(resolveSpotMarketStatus({
      source: 'LAST_GOOD',
      freshness: 'STALE',
      isHydrating: true,
    }).kind).toBe('loading');
  });

  it('preserves live and unavailable semantics after hydration', () => {
    expect(resolveSpotMarketStatus({ source: 'LIVE_WS', freshness: 'LIVE' }).kind).toBe('live');
    expect(resolveSpotMarketStatus({ source: 'MISSING', freshness: 'MISSING' }).kind).toBe('unavailable');
  });
});
