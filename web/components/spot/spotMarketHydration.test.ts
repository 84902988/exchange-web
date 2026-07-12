import { describe, expect, it } from '@jest/globals';
import { resolveSpotMarketHydration } from './spotMarketHydration';

describe('spot market hydration', () => {
  it('keeps the initial empty market in hydration while REST and WS are pending', () => {
    expect(resolveSpotMarketHydration({
      price: null,
      source: null,
      restLoading: true,
      connectionStatus: 'connecting',
    })).toMatchObject({ isHydrating: true, isUnavailable: false });
  });

  it('keeps a valid REST snapshot price visible while waiting for LIVE_WS', () => {
    expect(resolveSpotMarketHydration({
      price: '64044.1',
      source: 'REST_SNAPSHOT',
      restLoading: false,
      connectionStatus: 'open',
    })).toMatchObject({
      hasValidPrice: true,
      hasLivePrice: false,
      hasReadyPrice: false,
      isHydrating: true,
      isUnavailable: false,
    });
  });

  it('finishes hydration when a valid LIVE_WS price arrives', () => {
    expect(resolveSpotMarketHydration({
      price: '64044.2',
      source: 'LIVE_WS',
      restLoading: false,
      connectionStatus: 'open',
    })).toMatchObject({ hasLivePrice: true, hasReadyPrice: true, isHydrating: false, isUnavailable: false });
  });

  it.each(['RECENT', 'LIVE'])('finishes hydration for a valid INTERNAL %s price', (freshness) => {
    expect(resolveSpotMarketHydration({
      price: '1.010',
      source: 'INTERNAL',
      freshness,
      restLoading: false,
      connectionStatus: 'open',
    })).toMatchObject({
      hasValidPrice: true,
      hasLivePrice: false,
      hasReadyPrice: true,
      isHydrating: false,
      isUnavailable: false,
    });
  });

  it('keeps legacy INTERNAL callers ready when freshness is not provided', () => {
    expect(resolveSpotMarketHydration({
      price: '1.010',
      source: 'INTERNAL',
      restLoading: false,
      connectionStatus: 'open',
    })).toMatchObject({ hasLivePrice: false, hasReadyPrice: true, isHydrating: false });
  });

  it('does not treat a stale INTERNAL price as ready', () => {
    expect(resolveSpotMarketHydration({
      price: '1.010',
      source: 'INTERNAL',
      freshness: 'STALE',
      restLoading: false,
      connectionStatus: 'open',
    })).toMatchObject({ hasReadyPrice: false, isHydrating: true, isUnavailable: false });
  });

  it('keeps INTERNAL without a valid price loading while transport is available', () => {
    expect(resolveSpotMarketHydration({
      price: null,
      source: 'INTERNAL',
      freshness: 'RECENT',
      restLoading: false,
      connectionStatus: 'open',
    })).toMatchObject({ hasReadyPrice: false, isHydrating: true, isUnavailable: false });
  });

  it('reports INTERNAL without a valid price unavailable after transport closes', () => {
    expect(resolveSpotMarketHydration({
      price: null,
      source: 'INTERNAL',
      freshness: 'RECENT',
      restLoading: false,
      connectionStatus: 'closed',
    })).toMatchObject({ hasReadyPrice: false, isHydrating: false, isUnavailable: true });
  });

  it('does not report unavailable while WS is still connecting after REST failure', () => {
    expect(resolveSpotMarketHydration({
      price: null,
      source: null,
      restLoading: false,
      connectionStatus: 'connecting',
    })).toMatchObject({ isHydrating: true, isUnavailable: false });
  });

  it('reports unavailable only when both REST has no price and WS has failed', () => {
    expect(resolveSpotMarketHydration({
      price: null,
      source: null,
      restLoading: false,
      connectionStatus: 'closed',
    })).toMatchObject({ isHydrating: false, isUnavailable: true });
  });

  it('keeps a valid REST snapshot available after WS failure', () => {
    expect(resolveSpotMarketHydration({
      price: '64044.1',
      source: 'REST_SNAPSHOT',
      restLoading: false,
      connectionStatus: 'closed',
    })).toMatchObject({ isHydrating: false, isUnavailable: false });
  });
});
