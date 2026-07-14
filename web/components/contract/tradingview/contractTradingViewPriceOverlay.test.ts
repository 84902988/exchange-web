/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness loads transpiled module exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function loadModule(): Record<string, any> {
  const filePath = fileURLToPath(new URL('./contractTradingViewPriceOverlay.ts', import.meta.url));
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  new Function('require', 'module', 'exports', output)(
    () => { throw new Error('Unexpected import'); },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

const overlayModule = loadModule();

test('overlay updates only the horizontal drawing and follows explicit direction colors', async () => {
  const points: Array<Array<{ time: number; price: number }>> = [];
  const properties: Array<Record<string, unknown>> = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const chart = {
    async createShape(_point: unknown, options: Record<string, unknown>) {
      createCalls.push(options);
      return 'overlay-1';
    },
    getShapeById() {
      return {
        getPoints: () => [{ time: 1, price: 100 }],
        setPoints: (next: Array<{ time: number; price: number }>) => points.push(next),
        setProperties: (next: Record<string, unknown>) => properties.push(next),
      };
    },
    removeEntity() {},
  };
  const controller = new overlayModule.ContractTradingViewPriceOverlayController(chart);

  controller.update({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    displayPrice: 100,
    priceDirection: 'up',
  });
  await flushPromises();
  controller.update({
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    displayPrice: 99,
    priceDirection: 'down',
  });

  assert.equal(createCalls.length, 1);
  assert.equal((createCalls[0].overrides as Record<string, unknown>)['linetoolhorzline.linecolor'], '#00c087');
  assert.equal(points.at(-1)?.[0].price, 99);
  assert.equal(properties.at(-1)?.linecolor, '#f6465d');
  assert.equal('open' in (points.at(-1)?.[0] || {}), false);
  assert.equal('close' in (points.at(-1)?.[0] || {}), false);
});
test('symbol and interval changes remove the previous overlay before creating another', async () => {
  const removed: Array<string | number> = [];
  let sequence = 0;
  const chart = {
    async createShape() {
      sequence += 1;
      return `overlay-${sequence}`;
    },
    getShapeById() {
      return { setPoints() {}, setProperties() {} };
    },
    removeEntity(entityId: string | number) {
      removed.push(entityId);
    },
  };
  const controller = new overlayModule.ContractTradingViewPriceOverlayController(chart);
  controller.update({ symbol: 'BTCUSDT_PERP', interval: '1m', displayPrice: 100, priceDirection: 'flat' });
  await flushPromises();
  controller.update({ symbol: 'BTCUSDT_PERP', interval: '5m', displayPrice: 100, priceDirection: 'flat' });
  await flushPromises();
  controller.update({ symbol: 'ETHUSDT_PERP', interval: '5m', displayPrice: 200, priceDirection: 'up' });
  await flushPromises();

  assert.deepEqual(removed, ['overlay-1', 'overlay-2']);
  assert.equal(sequence, 3);
});

test('a retired async createShape result is removed and cannot reattach', async () => {
  const firstCreate = deferred<string>();
  const removed: Array<string | number> = [];
  let createCount = 0;
  const chart = {
    createShape() {
      createCount += 1;
      return createCount === 1 ? firstCreate.promise : Promise.resolve('overlay-current');
    },
    getShapeById() {
      return { setPoints() {}, setProperties() {} };
    },
    removeEntity(entityId: string | number) {
      removed.push(entityId);
    },
  };
  const controller = new overlayModule.ContractTradingViewPriceOverlayController(chart);
  controller.update({ symbol: 'BTCUSDT_PERP', interval: '1m', displayPrice: 100, priceDirection: 'up' });
  controller.reset();
  controller.update({ symbol: 'BTCUSDT_PERP', interval: '5m', displayPrice: 101, priceDirection: 'up' });
  await flushPromises();
  firstCreate.resolve('overlay-retired');
  await flushPromises();

  assert.equal(createCount, 2);
  assert.ok(removed.includes('overlay-retired'));
  assert.ok(!removed.includes('overlay-current'));
});
