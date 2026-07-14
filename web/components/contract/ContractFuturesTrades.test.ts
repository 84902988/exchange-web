/* eslint-disable @typescript-eslint/no-explicit-any -- Dynamic harness loads compiled TSX exports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type RenderNode = {
  type: unknown;
  props: Record<string, any>;
  key?: string | number | null;
};

function loadTypeScriptModule(
  filePath: string,
  mocks: Record<string, unknown>,
): Record<string, any> {
  const output = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const loadedModule: { exports: Record<string, any> } = { exports: {} };
  const localRequire = (specifier: string) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected test import: ${specifier}`);
  };
  const execute = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    output,
  );
  execute(
    localRequire,
    loadedModule,
    loadedModule.exports,
    filePath,
    filePath.slice(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))),
  );
  return loadedModule.exports;
}

const Fragment = Symbol('Fragment');
let tradesStoreSnapshot: Record<string, unknown> | null = null;

function createRenderNode(
  type: unknown,
  props: Record<string, any> | null,
  key?: string | number | null,
): unknown {
  const resolvedProps = props || {};
  if (type === Fragment) return resolvedProps.children;
  if (typeof type === 'function') return type(resolvedProps);
  return { type, props: resolvedProps, key } satisfies RenderNode;
}

const translations: Record<string, string> = {
  price: '\u4ef7\u683c',
  amount: '\u6570\u91cf',
  time: '\u65f6\u95f4',
  loading: '\u52a0\u8f7d\u4e2d',
  marketDataUnavailable: '\u5e02\u573a\u6570\u636e\u4e0d\u53ef\u7528',
  noTradeData: '\u6682\u65e0\u6210\u4ea4\u6570\u636e',
  closedNoRealtimeTrades: '\u4f11\u5e02\u65e0\u5b9e\u65f6\u6210\u4ea4',
};

const componentModule = loadTypeScriptModule(
  fileURLToPath(new URL('./ContractFuturesTrades.tsx', import.meta.url)),
  {
    react: {
      useEffect: (effect: () => void | (() => void)) => effect(),
      useMemo: (factory: () => unknown) => factory(),
    },
    'react/jsx-runtime': {
      Fragment,
      jsx: createRenderNode,
      jsxs: createRenderNode,
    },
    '@/lib/marketPrecision': {
      formatPrice: (value: number, precision: number) => value.toFixed(precision),
    },
    '@/contexts/LocaleContext': {
      useLocaleContext: () => ({
        t: (key: string) => translations[key] || key,
      }),
    },
    './contractMarketSourceStatus': {
      getContractDomainStatusLabel: () => '\u6210\u4ea4\u6765\u6e90: \u5b9e\u65f6',
      getContractMarketSourceLabel: () => '\u5b9e\u65f6',
      getContractMarketSourceTone: () => 'realtime',
      getContractMarketSourceToneClass: () => 'realtime',
    },
    './hooks/contractMarketStoreAdapter': {
      useContractTradesStoreSnapshot: () => tradesStoreSnapshot,
    },
  },
);

const ContractFuturesTrades = componentModule.default as (
  props: Record<string, unknown>,
) => unknown;

const legacyTrade = {
  id: 'legacy-1',
  price: '64000',
  qty: '1',
  time: 1_720_000_000_100,
  source: 'LIVE_WS',
  quote_freshness: 'LIVE',
};

const baseProps = {
  trades: [legacyTrade],
  loading: false,
  error: null,
  status: 'OPEN',
  source: 'LIVE_WS',
  freshness: 'LIVE',
  pricePrecision: 2,
};

function makeStoreSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT_PERP',
    trades: [{
      id: 'store-1',
      price: '65000',
      qty: '2',
      time: 1_720_000_000_200,
      source: 'LIVE_WS',
      quote_freshness: 'LIVE',
    }],
    source: 'LIVE_WS',
    freshness: 'LIVE',
    provider: 'BINANCE_USDM',
    providerGeneration: 9,
    revision: { epoch: 9, sequence: 30, isClosed: null, checksum: null },
    stale: false,
    observedAtMs: 1_720_000_000_200,
    ...overrides,
  };
}

function renderTrades(overrides: Record<string, unknown> = {}) {
  return ContractFuturesTrades({ ...baseProps, ...overrides }) as RenderNode;
}

function textContent(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  const node = value as RenderNode;
  return textContent(node.props?.children);
}

test('Trades reads Store first and emits a structured legacy diff', () => {
  tradesStoreSnapshot = makeStoreSnapshot();
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const tree = renderTrades();
    assert.match(textContent(tree), /65000\.00/);
    assert.doesNotMatch(textContent(tree), /64000\.00/);
    assert.equal(tree.props['data-market-authority'], 'STORE');
    assert.equal(tree.props['data-market-symbol'], 'BTCUSDT_PERP');
    assert.equal(tree.props['data-provider-generation'], 9);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[contract-trades-domain-diff]');
  } finally {
    console.info = originalInfo;
  }
});

test('Trades falls back to legacy only while Store is missing', () => {
  tradesStoreSnapshot = null;
  const tree = renderTrades();

  assert.match(textContent(tree), /64000\.00/);
  assert.equal(tree.props['data-market-authority'], 'LEGACY_FALLBACK');
});

test('symbol-switch loading guard never renders the previous Store trades', () => {
  tradesStoreSnapshot = makeStoreSnapshot({ symbol: 'BTCUSDT_PERP' });
  const tree = renderTrades({ trades: [], loading: true });

  assert.doesNotMatch(textContent(tree), /65000\.00/);
  assert.match(textContent(tree), /\u52a0\u8f7d\u4e2d/);
  assert.equal(tree.props['data-market-authority'], 'LEGACY_FALLBACK');
});

test('authoritative empty Store trades stay empty instead of reusing legacy rows', () => {
  tradesStoreSnapshot = makeStoreSnapshot({ trades: [] });
  const tree = renderTrades();

  assert.doesNotMatch(textContent(tree), /64000\.00/);
  assert.match(textContent(tree), /\u6682\u65e0\u6210\u4ea4\u6570\u636e/);
  assert.equal(tree.props['data-market-authority'], 'STORE');
});

test('legacy fallback never renders an explicitly synthetic trade', () => {
  tradesStoreSnapshot = null;
  const tree = renderTrades({
    trades: [{
      id: 'synthetic-legacy',
      price: '66000',
      qty: '1',
      time: 1_720_000_000_300,
      synthetic: true,
      price_source: 'SYNTHETIC_FROM_QUOTE',
    }],
  });

  assert.doesNotMatch(textContent(tree), /66000\.00/);
  assert.match(textContent(tree), /\u6682\u65e0\u6210\u4ea4\u6570\u636e/);
  assert.equal(tree.props['data-market-authority'], 'LEGACY_FALLBACK');
});
