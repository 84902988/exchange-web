import { describe, expect, it, jest } from '@jest/globals';
import {
  ensureSpotReferencePriceViewport,
  SpotReferenceViewportCoordinator,
  SpotTradingViewReferenceOverlayController,
  type SpotTradingViewReferenceOverlayChart,
  type SpotTradingViewReferenceOverlayValue,
} from './spotTradingViewReferenceOverlay';

function referenceValue(
  overrides: Partial<SpotTradingViewReferenceOverlayValue> = {},
): SpotTradingViewReferenceOverlayValue {
  return {
    symbol: 'MFCUSDT',
    interval: '1m',
    price: 0.108,
    anchorTime: 1_717_000_060_000,
    title: 'Iron ore reference',
    color: '#f0b90b',
    ...overrides,
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SpotTradingViewReferenceOverlayController', () => {
  it('creates and updates a separate configured reference line', async () => {
    const setPoints = jest.fn();
    const setProperties = jest.fn();
    const createShape = jest.fn<SpotTradingViewReferenceOverlayChart['createShape']>(
      async () => 'reference-1',
    );
    const chart: SpotTradingViewReferenceOverlayChart = {
      createShape,
      getShapeById: () => ({
        getPoints: () => [{ time: 1_717_000_060, price: 0.108 }],
        setPoints,
        setProperties,
      }),
      removeEntity: jest.fn(),
    };
    const controller = new SpotTradingViewReferenceOverlayController(chart);

    controller.update(referenceValue());
    await flushPromises();
    controller.update(referenceValue({ price: 0.109, title: 'Updated reference' }));

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(createShape.mock.calls[0][0]).toEqual({ time: 1_717_000_060, price: 0.108 });
    expect(createShape.mock.calls[0][1]).toMatchObject({
      shape: 'horizontal_line',
      lock: true,
      disableSave: true,
      text: 'Iron ore reference',
      overrides: {
        'linetoolhorzline.linecolor': '#f0b90b',
        'linetoolhorzline.linestyle': 2,
        'linetoolhorzline.showPrice': true,
      },
    });
    expect(setPoints).toHaveBeenLastCalledWith([{ time: 1_717_000_060, price: 0.109 }]);
    expect(setProperties).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'Updated reference',
      linecolor: '#f0b90b',
      showPrice: true,
    }));
  });

  it('recreates the line once after a resolution reset removes the drawing', async () => {
    let createCount = 0;
    const activeEntities = new Set<string>();
    const chart: SpotTradingViewReferenceOverlayChart = {
      createShape: async () => {
        const id = `reference-${++createCount}`;
        activeEntities.add(id);
        return id;
      },
      getShapeById: (entityId) => {
        if (!activeEntities.has(String(entityId))) throw new Error('drawing removed');
        return {
          getPoints: () => [{ time: 1_717_000_060, price: 0.108 }],
          setPoints: jest.fn(),
        };
      },
      removeEntity: (entityId) => {
        activeEntities.delete(String(entityId));
      },
    };
    const controller = new SpotTradingViewReferenceOverlayController(chart);

    controller.update(referenceValue());
    await flushPromises();
    activeEntities.clear();
    controller.update(referenceValue());
    await flushPromises();

    expect(createCount).toBe(2);
    expect(activeEntities).toEqual(new Set(['reference-2']));
  });

  it('fences a late line from an old symbol and cleans it on destroy', async () => {
    let resolveCreate!: (value: string) => void;
    const removeEntity = jest.fn();
    const chart: SpotTradingViewReferenceOverlayChart = {
      createShape: () => new Promise((resolve) => {
        resolveCreate = resolve;
      }),
      getShapeById: () => ({ setPoints: jest.fn() }),
      removeEntity,
    };
    const controller = new SpotTradingViewReferenceOverlayController(chart);

    controller.update(referenceValue());
    controller.destroy();
    resolveCreate('late-reference');
    await flushPromises();

    expect(removeEntity).toHaveBeenCalledWith('late-reference', { disableUndo: true });
  });
});

describe('Spot reference viewport', () => {
  it('expands once to include an off-screen configured reference price', () => {
    const setVisiblePriceRange = jest.fn();
    const chart = {
      createShape: async () => 'reference-1',
      getShapeById: () => ({ setPoints: jest.fn() }),
      removeEntity: jest.fn(),
      getPanes: () => [{
        hasMainSeries: () => true,
        getMainSourcePriceScale: () => ({
          getVisiblePriceRange: () => ({ from: 0.015, to: 0.017 }),
          setVisiblePriceRange,
        }),
      }],
    } satisfies SpotTradingViewReferenceOverlayChart;

    expect(ensureSpotReferencePriceViewport({
      chart,
      referencePrice: 0.108,
      isCurrent: () => true,
    })).toBe('APPLIED');
    expect(setVisiblePriceRange).toHaveBeenCalledTimes(1);
    const appliedRange = setVisiblePriceRange.mock.calls[0][0] as { from: number; to: number };
    expect(appliedRange.from).toBeLessThan(0.015);
    expect(appliedRange.to).toBeGreaterThan(0.108);
  });

  it('does not rescale again for realtime updates in the same scope', () => {
    const setVisiblePriceRange = jest.fn();
    const chart = {
      createShape: async () => 'reference-1',
      getShapeById: () => ({ setPoints: jest.fn() }),
      removeEntity: jest.fn(),
      getPanes: () => [{
        hasMainSeries: () => true,
        getMainSourcePriceScale: () => ({
          getVisiblePriceRange: () => ({ from: 0.015, to: 0.017 }),
          setVisiblePriceRange,
        }),
      }],
    } satisfies SpotTradingViewReferenceOverlayChart;
    const coordinator = new SpotReferenceViewportCoordinator();

    expect(coordinator.ensure({
      scope: 'MFCUSDT:1m:0.108:1',
      chart,
      referencePrice: 0.108,
      isCurrent: () => true,
    })).toBe('APPLIED');
    expect(coordinator.ensure({
      scope: 'MFCUSDT:1m:0.108:1',
      chart,
      referencePrice: 0.108,
      isCurrent: () => true,
    })).toBe('ALREADY');
    expect(setVisiblePriceRange).toHaveBeenCalledTimes(1);
  });
});
