import { describe, expect, it, jest } from '@jest/globals';
import {
  isCurrentSpotTradingViewKlineFallback,
  SpotTradingViewPriceOverlayController,
  type SpotTradingViewOverlayChart,
  type SpotTradingViewOverlayEntityId,
} from './spotTradingViewPriceOverlay';
import type { SpotDisplayPrice } from '../spotDisplayPrice';

function displayPrice(overrides: Partial<SpotDisplayPrice> = {}): SpotDisplayPrice {
  return {
    symbol: 'BTCUSDT',
    price: '101',
    eventTimeMs: 2_000,
    receivedAtMs: 2_100,
    sourceDomain: 'trades',
    source: 'LIVE_WS',
    provider: 'OKX_SPOT',
    freshness: 'LIVE',
    isRealTrade: true,
    ...overrides,
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SpotTradingViewPriceOverlayController', () => {
  it('creates one horizontal line and updates it without touching any candle fields', async () => {
    const points: unknown[] = [];
    const properties: unknown[] = [];
    const createShape = jest.fn<SpotTradingViewOverlayChart['createShape']>(async () => 'overlay-1');
    const chart: SpotTradingViewOverlayChart = {
      createShape,
      getShapeById: () => ({
        getPoints: () => [{ time: 2, price: 101 }],
        setPoints: (next) => points.push(next),
        setProperties: (next) => properties.push(next),
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice());
    await flushPromises();
    controller.update(displayPrice({ price: '102', eventTimeMs: 3_000 }));

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(createShape.mock.calls[0][1]).toMatchObject({
      shape: 'horizontal_line',
      lock: true,
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      showInObjectsTree: false,
      zOrder: 'top',
      text: '',
      overrides: {
        'linetoolhorzline.linecolor': '#00c087',
        'linetoolhorzline.textcolor': '#00c087',
        'linetoolhorzline.linewidth': 1,
        'linetoolhorzline.linestyle': 2,
        'linetoolhorzline.showPrice': true,
      },
    });
    expect(points.at(-1)).toEqual([{ time: 2, price: 102 }]);
    expect(properties.at(-1)).toMatchObject({
      text: '',
      linecolor: '#00c087',
      textcolor: '#00c087',
      linestyle: 2,
      showPrice: true,
    });
    expect(JSON.stringify({ points, properties })).not.toMatch(/open|high|low|close|volume/i);
  });

  it('uses price direction colors and keeps the previous color when price is unchanged', async () => {
    const properties: Array<Record<string, unknown>> = [];
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({
        getPoints: () => [{ time: 2, price: 101 }],
        setPoints: jest.fn(),
        setProperties: (next) => properties.push(next),
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice({ price: '101' }));
    await flushPromises();
    controller.update(displayPrice({ price: '100', eventTimeMs: 3_000 }));
    controller.update(displayPrice({ price: '100', eventTimeMs: 4_000 }));
    controller.update(displayPrice({ price: '102', eventTimeMs: 5_000 }));

    expect(properties.map((item) => item.linecolor)).toEqual([
      '#f6465d',
      '#f6465d',
      '#00c087',
    ]);
  });

  it('creates a ticker fallback with the final exchange color instead of a blue interim state', async () => {
    const createShape = jest.fn<SpotTradingViewOverlayChart['createShape']>(async () => 'overlay-1');
    const chart: SpotTradingViewOverlayChart = {
      createShape,
      getShapeById: () => ({ setPoints: jest.fn() }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice({
      sourceDomain: 'ticker',
      isRealTrade: false,
    }));
    await flushPromises();

    expect(createShape.mock.calls[0][1]).toMatchObject({
      text: '',
      overrides: {
        'linetoolhorzline.linecolor': '#00c087',
        'linetoolhorzline.textcolor': '#00c087',
        'linetoolhorzline.linestyle': 2,
        'linetoolhorzline.showPrice': true,
      },
    });
  });

  it('cleans the old symbol entity before creating the new symbol overlay', async () => {
    let createCount = 0;
    const activeEntities = new Set<SpotTradingViewOverlayEntityId>();
    const removeEntity = jest.fn<SpotTradingViewOverlayChart['removeEntity']>((entityId) => {
      activeEntities.delete(entityId);
    });
    const createShape = jest.fn<SpotTradingViewOverlayChart['createShape']>(async () => {
      const entityId = `overlay-${++createCount}`;
      activeEntities.add(entityId);
      return entityId;
    });
    const chart: SpotTradingViewOverlayChart = {
      createShape,
      getShapeById: () => ({ getPoints: () => [{ time: 2, price: 101 }], setPoints: jest.fn() }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice({ symbol: 'BTCUSDT', price: '101' }));
    await flushPromises();
    controller.update(displayPrice({ symbol: 'ETHUSDT', price: '99', eventTimeMs: 3_000 }));
    await flushPromises();

    expect(removeEntity).toHaveBeenCalledWith('overlay-1', { disableUndo: true });
    expect(createShape).toHaveBeenCalledTimes(2);
    expect(activeEntities).toEqual(new Set(['overlay-2']));
    expect(createShape.mock.calls[1][1]).toMatchObject({
      text: '',
      overrides: {
        'linetoolhorzline.linecolor': '#00c087',
        'linetoolhorzline.linestyle': 2,
      },
    });
  });

  it('does not duplicate an overlay while creation is in flight', async () => {
    let resolveShape!: (value: SpotTradingViewOverlayEntityId) => void;
    const createShape = jest.fn(() => new Promise<SpotTradingViewOverlayEntityId>((resolve) => {
      resolveShape = resolve;
    }));
    const setPoints = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape,
      getShapeById: () => ({ getPoints: () => [{ time: 2, price: 101 }], setPoints }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice({ price: '101' }));
    controller.update(displayPrice({ price: '102', eventTimeMs: 3_000 }));
    resolveShape('overlay-1');
    await flushPromises();

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(setPoints).toHaveBeenLastCalledWith([{ time: 2, price: 102 }]);
  });

  it('removes the line for stale or missing display state', async () => {
    const removeEntity = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({ getPoints: () => [{ time: 2, price: 101 }], setPoints: jest.fn() }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice());
    await flushPromises();
    controller.update(displayPrice({ freshness: 'STALE' }));

    expect(removeEntity).toHaveBeenCalledWith('overlay-1', { disableUndo: true });
  });

  it('replaces one unsupported drawing without leaving a duplicate overlay', async () => {
    let createCount = 0;
    const activeEntities = new Set<SpotTradingViewOverlayEntityId>();
    let maxActiveEntities = 0;
    const removeEntity = jest.fn<SpotTradingViewOverlayChart['removeEntity']>((entityId) => {
      activeEntities.delete(entityId);
    });
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => {
        const entityId = `overlay-${++createCount}`;
        activeEntities.add(entityId);
        maxActiveEntities = Math.max(maxActiveEntities, activeEntities.size);
        return entityId;
      },
      getShapeById: () => ({
        getPoints: () => {
          throw new Error('drawing points unavailable');
        },
        setPoints: jest.fn(),
      }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice({ price: '101' }));
    await flushPromises();
    controller.update(displayPrice({ price: '101', eventTimeMs: 3_000 }));
    await flushPromises();

    expect(createCount).toBe(2);
    expect(maxActiveEntities).toBe(1);
    expect(activeEntities).toEqual(new Set(['overlay-2']));
    expect(removeEntity).toHaveBeenCalledTimes(1);
    expect(removeEntity).toHaveBeenCalledWith('overlay-1', { disableUndo: true });
  });

  it('recovers as one system overlay after ordinary drawings cleanup removed its entity', async () => {
    let createCount = 0;
    const activeEntities = new Set<SpotTradingViewOverlayEntityId>(['ordinary-drawing']);
    let maxSystemEntities = 0;
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => {
        const entityId = `system-overlay-${++createCount}`;
        activeEntities.add(entityId);
        maxSystemEntities = Math.max(
          maxSystemEntities,
          Array.from(activeEntities).filter((id) => String(id).startsWith('system-overlay-')).length,
        );
        return entityId;
      },
      getShapeById: (entityId) => {
        if (!activeEntities.has(entityId)) throw new Error('entity removed by chart cleanup');
        return { getPoints: () => [{ time: 2, price: 101 }], setPoints: jest.fn() };
      },
      removeEntity: (entityId) => {
        if (!activeEntities.delete(entityId)) throw new Error('entity already removed');
      },
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice({ price: '101' }));
    await flushPromises();
    activeEntities.delete('ordinary-drawing');
    activeEntities.delete('system-overlay-1');
    controller.update(displayPrice({ price: '101', eventTimeMs: 3_000 }));
    await flushPromises();

    expect(createCount).toBe(2);
    expect(maxSystemEntities).toBe(1);
    expect(activeEntities).toEqual(new Set(['system-overlay-2']));
  });

  it('rejects late Kline fallback metadata from an old symbol or resolution', () => {
    expect(isCurrentSpotTradingViewKlineFallback({
      eventSymbol: 'BTCUSDT',
      eventInterval: '1m',
      activeSymbol: 'ETHUSDT',
      activeBackendInterval: '1m',
    })).toBe(false);
    expect(isCurrentSpotTradingViewKlineFallback({
      eventSymbol: 'BTCUSDT',
      eventInterval: '1m',
      activeSymbol: 'BTCUSDT',
      activeBackendInterval: '1d',
    })).toBe(false);
    expect(isCurrentSpotTradingViewKlineFallback({
      eventSymbol: 'BTC/USDT',
      eventInterval: '1M',
      activeSymbol: 'BTCUSDT',
      activeBackendInterval: '1M',
    })).toBe(true);
  });

  it('stops updating and cleans the overlay on destroy', async () => {
    const setPoints = jest.fn();
    const removeEntity = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({ getPoints: () => [{ time: 2, price: 101 }], setPoints }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice());
    await flushPromises();
    const callsBeforeDestroy = setPoints.mock.calls.length;
    controller.destroy();
    controller.update(displayPrice({ price: '103' }));

    expect(removeEntity).toHaveBeenCalledWith('overlay-1', { disableUndo: true });
    expect(setPoints).toHaveBeenCalledTimes(callsBeforeDestroy);
  });

  it('removes an in-flight entity that resolves after widget destroy', async () => {
    let resolveShape!: (value: SpotTradingViewOverlayEntityId) => void;
    const removeEntity = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape: () => new Promise((resolve) => {
        resolveShape = resolve;
      }),
      getShapeById: () => ({ setPoints: jest.fn() }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(displayPrice());
    controller.destroy();
    resolveShape('late-overlay');
    await flushPromises();

    expect(removeEntity).toHaveBeenCalledTimes(1);
    expect(removeEntity).toHaveBeenCalledWith('late-overlay', { disableUndo: true });
  });
});
