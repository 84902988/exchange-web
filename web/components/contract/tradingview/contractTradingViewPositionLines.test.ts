import { describe, expect, it } from '@jest/globals';

import {
  buildContractTradingViewPositionLines,
  ContractTradingViewPositionLinesController,
} from './contractTradingViewPositionLines';
import type { ContractTradingViewOverlayEntityId } from './contractTradingViewPriceOverlay';

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    symbol: 'BTCUSDT_PERP',
    side: 'LONG',
    leverage: 10,
    quantity: '1',
    entry_price: '100',
    mark_price: '101',
    margin_amount: '10',
    open_fee: '0',
    unrealized_pnl: '1',
    realized_pnl: '0',
    warning_price: '50',
    take_profit_price: '110',
    stop_loss_price: '90',
    status: 'OPEN',
    ...overrides,
  };
}

function settlePositionLineQueue(delayMs = 320) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForPositionLineState(predicate: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for position-line controller state');
    await settlePositionLineQueue(10);
  }
}

describe('buildContractTradingViewPositionLines', () => {
  it('builds entry, take-profit and stop-loss lines only for the active open symbol', () => {
    expect(buildContractTradingViewPositionLines([
      position(),
      position({ id: 8, symbol: 'ETHUSDT_PERP' }),
      position({ id: 9, status: 'CLOSED' }),
    ], 'BTCUSDT_PERP')).toEqual([
      expect.objectContaining({ key: '7:ENTRY', price: 100, text: 'BUY ENTRY#1' }),
      expect.objectContaining({ key: '7:SL', price: 90, text: 'BUY SL#1' }),
      expect.objectContaining({ key: '7:TP', price: 110, text: 'BUY TP#1' }),
    ]);
  });

  it('assigns one stable number to every line belonging to the same position', () => {
    const lines = buildContractTradingViewPositionLines([
      position({ id: 12, side: 'SHORT' }),
      position({ id: 7, side: 'LONG' }),
    ], 'BTCUSDT_PERP');

    expect(lines.filter((line) => line.key.startsWith('7:')).map((line) => line.text).sort()).toEqual([
      'BUY ENTRY#1',
      'BUY SL#1',
      'BUY TP#1',
    ]);
    expect(lines.filter((line) => line.key.startsWith('12:')).map((line) => line.text).sort()).toEqual([
      'SELL ENTRY#2',
      'SELL SL#2',
      'SELL TP#2',
    ]);
  });

  it('fails closed for invalid optional line prices', () => {
    expect(buildContractTradingViewPositionLines([
      position({ take_profit_price: null, stop_loss_price: '-1' }),
    ], 'BTCUSDT_PERP')).toHaveLength(1);
  });
});

describe('ContractTradingViewPositionLinesController', () => {
  it('serializes TradingView shape creation so one position can render entry, TP, and SL reliably', async () => {
    let nextId = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const shapes = new Map<number, { point: { time: number; price: number } }>();
    const chart = {
      createShape: async (point: { time: number; price: number }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        const id = ++nextId;
        shapes.set(id, { point });
        inFlight -= 1;
        return id;
      },
      getShapeById: () => ({ setPoints: () => undefined }),
      removeEntity: (entityId: ContractTradingViewOverlayEntityId) => {
        shapes.delete(Number(entityId));
      },
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', buildContractTradingViewPositionLines([position()], 'BTCUSDT_PERP'));
    await waitForPositionLineState(() => shapes.size === 3);

    expect(maxInFlight).toBe(1);
    expect(nextId).toBe(3);
    expect(shapes.size).toBe(3);
  });

  it('creates off-viewport TP and SL drawings at the visible entry anchor before moving them', async () => {
    let nextId = 0;
    const createdAt: number[] = [];
    const points = new Map<number, Array<{ time: number; price: number }>>();
    const chart = {
      createShape: async (point: { time: number; price: number }) => {
        const id = ++nextId;
        createdAt.push(point.price);
        points.set(id, [point]);
        return id;
      },
      getShapeById: (entityId: ContractTradingViewOverlayEntityId) => ({
        getPoints: () => points.get(Number(entityId)) || [],
        setPoints: (nextPoints: Array<{ time: number; price: number }>) => points.set(Number(entityId), nextPoints),
        setProperties: () => undefined,
      }),
      removeEntity: () => undefined,
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', buildContractTradingViewPositionLines([position()], 'BTCUSDT_PERP'));
    await waitForPositionLineState(() => (
      createdAt.length === 3
      && Array.from(points.values()).map((value) => value[0]?.price).sort((a, b) => a - b).join(',') === '90,100,110'
    ));

    expect(createdAt).toEqual([100, 100, 100]);
    expect(Array.from(points.values()).map((value) => value[0].price).sort((a, b) => a - b)).toEqual([90, 100, 110]);
  });

  it('retries a transient TradingView createShape rejection without waiting for another position update', async () => {
    let attempts = 0;
    const chart = {
      createShape: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient chart rejection');
        return 7;
      },
      getShapeById: () => ({ setPoints: () => undefined }),
      removeEntity: () => undefined,
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', [{ key: '7:ENTRY', kind: 'ENTRY', price: 100, text: 'BUY ENTRY' }]);
    await settlePositionLineQueue(260);

    expect(attempts).toBe(2);
  });

  it('waits for a newly-created TradingView shape handle instead of recreating the drawing', async () => {
    let createAttempts = 0;
    let lookupAttempts = 0;
    let appliedPrice = 0;
    const chart = {
      createShape: async () => {
        createAttempts += 1;
        return 7;
      },
      getShapeById: () => {
        lookupAttempts += 1;
        if (lookupAttempts < 3) throw new Error('shape handle is not ready');
        return {
          getPoints: () => [{ time: 1, price: 100 }],
          setPoints: (points: Array<{ time: number; price: number }>) => {
            appliedPrice = points[0]?.price || 0;
          },
        };
      },
      removeEntity: () => undefined,
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', [{ key: '7:TP', kind: 'TAKE_PROFIT', price: 110, text: 'BUY TP' }]);
    await settlePositionLineQueue(500);

    expect(createAttempts).toBe(1);
    expect(lookupAttempts).toBe(3);
    expect(appliedPrice).toBe(110);
  });

  it('moves TP and SL only after TradingView has committed the anchored shape', async () => {
    let nextId = 0;
    const createdAt = new Map<number, number>();
    const points = new Map<number, Array<{ time: number; price: number }>>();
    const chart = {
      createShape: async (point: { time: number; price: number }) => {
        const id = ++nextId;
        createdAt.set(id, Date.now());
        points.set(id, [point]);
        return id;
      },
      getShapeById: (entityId: ContractTradingViewOverlayEntityId) => ({
        getPoints: () => points.get(Number(entityId)) || [],
        setPoints: (nextPoints: Array<{ time: number; price: number }>) => {
          const ageMs = Date.now() - (createdAt.get(Number(entityId)) || 0);
          if (ageMs >= 100) points.set(Number(entityId), nextPoints);
        },
      }),
      removeEntity: () => undefined,
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', buildContractTradingViewPositionLines([position()], 'BTCUSDT_PERP'));
    await settlePositionLineQueue(700);

    expect(Array.from(points.values()).map((value) => value[0].price).sort((a, b) => a - b)).toEqual([90, 100, 110]);
  });

  it('rejects duplicate TradingView entity ids and retries until every position line owns one entity', async () => {
    const returnedIds = [1, 1, 2, 2, 3];
    const chart = {
      createShape: async () => returnedIds.shift() ?? 3,
      getShapeById: () => ({ setPoints: () => undefined }),
      removeEntity: () => undefined,
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', buildContractTradingViewPositionLines([position()], 'BTCUSDT_PERP'));
    await settlePositionLineQueue(900);

    expect(returnedIds).toHaveLength(0);
  });

  it('retries invalid TradingView entity ids instead of recording phantom drawings', async () => {
    let attempts = 0;
    const chart = {
      createShape: async () => {
        attempts += 1;
        return (attempts === 1 ? null : 7) as unknown as ContractTradingViewOverlayEntityId;
      },
      getShapeById: () => ({ setPoints: () => undefined }),
      removeEntity: () => undefined,
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', [{ key: '7:ENTRY', kind: 'ENTRY', price: 100, text: 'BUY ENTRY' }]);
    await settlePositionLineQueue(500);

    expect(attempts).toBe(2);
  });

  it('updates shapes in place and removes stale lines without recreating the widget', async () => {
    let nextId = 0;
    const shapes = new Map<number, { points: Array<{ time: number; price: number }>; properties: Record<string, unknown> }>();
    const removed: number[] = [];
    const chart = {
      createShape: async (point: { time: number; price: number }) => {
        const id = ++nextId;
        shapes.set(id, { points: [point], properties: {} });
        return id;
      },
      getShapeById: (entityId: ContractTradingViewOverlayEntityId) => ({
        getPoints: () => shapes.get(Number(entityId))?.points || [],
        setPoints: (points: Array<{ time: number; price: number }>) => {
          const shape = shapes.get(Number(entityId));
          if (shape) shape.points = points;
        },
        setProperties: (properties: Record<string, unknown>) => {
          const shape = shapes.get(Number(entityId));
          if (shape) shape.properties = properties;
        },
      }),
      removeEntity: (entityId: ContractTradingViewOverlayEntityId) => {
        const id = Number(entityId);
        removed.push(id);
        shapes.delete(id);
      },
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('BTCUSDT_PERP', [{ key: '7:ENTRY', kind: 'ENTRY', price: 100, text: 'BUY ENTRY' }]);
    await settlePositionLineQueue();
    controller.update('BTCUSDT_PERP', [{ key: '7:ENTRY', kind: 'ENTRY', price: 101, text: 'BUY ENTRY' }]);

    expect(nextId).toBe(1);
    expect(shapes.get(1)?.points[0].price).toBe(101);

    controller.update('BTCUSDT_PERP', []);
    expect(removed).toEqual([1]);
  });

  it('discards a late shape created for a retired symbol scope', async () => {
    let resolveCreate: (id: number) => void = () => undefined;
    const removed: number[] = [];
    const chart = {
      createShape: () => new Promise<number>((resolve) => { resolveCreate = resolve; }),
      getShapeById: () => ({ setPoints: () => undefined }),
      removeEntity: (entityId: ContractTradingViewOverlayEntityId) => { removed.push(Number(entityId)); },
    };
    const controller = new ContractTradingViewPositionLinesController(chart);

    controller.update('ETHUSDT_PERP', [{ key: '1:ENTRY', kind: 'ENTRY', price: 50, text: 'BUY ENTRY' }]);
    await settlePositionLineQueue(100);
    controller.update('BTCUSDT_PERP', []);
    resolveCreate(9);
    await Promise.resolve();

    expect(removed).toEqual([9]);
  });
});
