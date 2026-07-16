import { describe, expect, it, jest } from '@jest/globals';
import {
  isCurrentSpotTradingViewKlineFallback,
  SpotTradingViewPriceOverlayController,
  type SpotTradingViewCandleOverlayValue,
  type SpotTradingViewOverlayChart,
  type SpotTradingViewOverlayEntityId,
} from './spotTradingViewPriceOverlay';

function candleOverlay(
  overrides: Partial<SpotTradingViewCandleOverlayValue> = {},
): SpotTradingViewCandleOverlayValue {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    close: 101,
    barTime: 1_717_000_060_000,
    source: 'native-open',
    receivedAtMs: 2_100,
    ...overrides,
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SpotTradingViewPriceOverlayController', () => {
  it('creates one horizontal line and updates it from candle close only', async () => {
    const points: unknown[] = [];
    const properties: unknown[] = [];
    const createShape = jest.fn<SpotTradingViewOverlayChart['createShape']>(async () => 'overlay-1');
    const chart: SpotTradingViewOverlayChart = {
      createShape,
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints: (next) => points.push(next),
        setProperties: (next) => properties.push(next),
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay());
    await flushPromises();
    controller.update(candleOverlay({ close: 102, source: 'preview', receivedAtMs: 3_000 }));

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(createShape.mock.calls[0][0]).toEqual({ time: 1_717_000_060, price: 101 });
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
    expect(points.at(-1)).toEqual([{ time: 1_717_000_060, price: 102 }]);
    expect(properties.at(-1)).toMatchObject({
      text: '',
      linecolor: '#00c087',
      textcolor: '#00c087',
      linestyle: 2,
      showPrice: true,
    });
  });

  it('keeps the chart line unchanged when only the ticker/header price moves', async () => {
    const setPoints = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints,
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);
    let headerLastPrice = 101;

    controller.update(candleOverlay({ close: 101 }));
    await flushPromises();
    headerLastPrice = 105;

    expect(headerLastPrice).toBe(105);
    expect(setPoints).not.toHaveBeenCalled();
  });

  it('follows a Preview candle update and then the final Native rebase close', async () => {
    const setPoints = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints,
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ close: 101, source: 'native-open' }));
    await flushPromises();
    controller.update(candleOverlay({ close: 104, source: 'preview', receivedAtMs: 2_200 }));
    controller.update(candleOverlay({ close: 102, source: 'native-closed', receivedAtMs: 2_300 }));

    expect(setPoints.mock.calls.map(([points]) => points)).toEqual([
      [{ time: 1_717_000_060, price: 104 }],
      [{ time: 1_717_000_060, price: 102 }],
    ]);
  });

  it('removes the old candle line and establishes a new one at the minute boundary', async () => {
    let createCount = 0;
    const removeEntity = jest.fn<SpotTradingViewOverlayChart['removeEntity']>();
    const createShape = jest.fn<SpotTradingViewOverlayChart['createShape']>(async () => (
      `overlay-${++createCount}`
    ));
    const chart: SpotTradingViewOverlayChart = {
      createShape,
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints: jest.fn(),
      }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ close: 101 }));
    await flushPromises();
    controller.update(candleOverlay({
      close: 103,
      barTime: 1_717_000_120_000,
      source: 'native-open',
      receivedAtMs: 3_000,
    }));
    await flushPromises();

    expect(removeEntity).toHaveBeenCalledWith('overlay-1', { disableUndo: true });
    expect(createShape).toHaveBeenCalledTimes(2);
    expect(createShape.mock.calls[1][0]).toEqual({ time: 1_717_000_120, price: 103 });
  });

  it('uses price direction colors and keeps the previous color when price is unchanged', async () => {
    const properties: Array<Record<string, unknown>> = [];
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints: jest.fn(),
        setProperties: (next) => properties.push(next),
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ close: 101 }));
    await flushPromises();
    controller.update(candleOverlay({ close: 100, source: 'preview', receivedAtMs: 3_000 }));
    controller.update(candleOverlay({ close: 100, source: 'preview', receivedAtMs: 4_000 }));
    controller.update(candleOverlay({ close: 102, source: 'preview', receivedAtMs: 5_000 }));

    expect(properties.map((item) => item.linecolor)).toEqual([
      '#00c087',
      '#f6465d',
      '#f6465d',
      '#00c087',
    ]);
  });

  it('applies the latest down color immediately when an in-flight entity is created', async () => {
    let resolveShape!: (value: SpotTradingViewOverlayEntityId) => void;
    const properties: Array<Record<string, unknown>> = [];
    const chart: SpotTradingViewOverlayChart = {
      createShape: () => new Promise<SpotTradingViewOverlayEntityId>((resolve) => {
        resolveShape = resolve;
      }),
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints: jest.fn(),
        setProperties: (next) => properties.push(next),
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ close: 101 }));
    controller.update(candleOverlay({ close: 100, source: 'preview', receivedAtMs: 3_000 }));
    resolveShape('overlay-1');
    await flushPromises();

    expect(properties[0]).toMatchObject({
      text: '',
      linecolor: '#f6465d',
      textcolor: '#f6465d',
      linewidth: 1,
      linestyle: 2,
      showPrice: true,
    });
  });

  it('cleans the old scope entity before creating the new symbol overlay', async () => {
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
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints: jest.fn(),
      }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ symbol: 'BTCUSDT', close: 101 }));
    await flushPromises();
    controller.update(candleOverlay({ symbol: 'ETHUSDT', close: 99, receivedAtMs: 3_000 }));
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
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints,
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ close: 101 }));
    controller.update(candleOverlay({ close: 102, source: 'preview', receivedAtMs: 3_000 }));
    resolveShape('overlay-1');
    await flushPromises();

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(setPoints).toHaveBeenLastCalledWith([{ time: 1_717_000_060, price: 102 }]);
  });

  it('removes the line for invalid candle state', async () => {
    const removeEntity = jest.fn();
    const chart: SpotTradingViewOverlayChart = {
      createShape: async () => 'overlay-1',
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints: jest.fn(),
      }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay());
    await flushPromises();
    controller.update(candleOverlay({ close: Number.NaN }));

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

    controller.update(candleOverlay({ close: 101 }));
    await flushPromises();
    controller.update(candleOverlay({ close: 101, source: 'preview', receivedAtMs: 3_000 }));
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
        return {
          getPoints: () => [{ time: 1_717_000_060, price: 101 }],
          setPoints: jest.fn(),
        };
      },
      removeEntity: (entityId) => {
        if (!activeEntities.delete(entityId)) throw new Error('entity already removed');
      },
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay({ close: 101 }));
    await flushPromises();
    activeEntities.delete('ordinary-drawing');
    activeEntities.delete('system-overlay-1');
    controller.update(candleOverlay({ close: 101, source: 'preview', receivedAtMs: 3_000 }));
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
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 101 }],
        setPoints,
      }),
      removeEntity,
    };
    const controller = new SpotTradingViewPriceOverlayController(chart);

    controller.update(candleOverlay());
    await flushPromises();
    const callsBeforeDestroy = setPoints.mock.calls.length;
    controller.destroy();
    controller.update(candleOverlay({ close: 103 }));

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

    controller.update(candleOverlay());
    controller.destroy();
    resolveShape('late-overlay');
    await flushPromises();

    expect(removeEntity).toHaveBeenCalledTimes(1);
    expect(removeEntity).toHaveBeenCalledWith('late-overlay', { disableUndo: true });
  });
});
