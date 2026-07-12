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
    })).toMatchObject({ hasLivePrice: true, isHydrating: false, isUnavailable: false });
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
