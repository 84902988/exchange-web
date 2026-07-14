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
  const source = readFileSync(filePath, 'utf8');
  const output = ts.transpileModule(source, {
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

const translations: Record<string, string> = {
  orderBook: '\u76d8\u53e3',
  price: '\u4ef7\u683c',
  amount: '\u6570\u91cf',
  total: '\u7d2f\u8ba1',
  loading: '\u52a0\u8f7d\u4e2d',
  noOrderBookData: '\u6682\u65e0\u76d8\u53e3\u6570\u636e',
  marketDataUnavailable: '\u5e02\u573a\u6570\u636e\u4e0d\u53ef\u7528',
  realtimeQuoteLabel: '\u5b9e\u65f6',
  latestPrice: '\u6700\u65b0\u4ef7',
  midPrice: '\u4e2d\u95f4\u4ef7',
  klineLatestPrice: 'K\u7ebf\u6700\u65b0\u4ef7',
};

let currentDisplayMode = 'FULL';
let orderBookStoreSnapshot: Record<string, unknown> | null = null;
const Fragment = Symbol('Fragment');

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

const utilsModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractOrderBook.utils.ts', import.meta.url)),
  {},
);

const componentModule = loadTypeScriptModule(
  fileURLToPath(new URL('./ContractFuturesOrderBook.tsx', import.meta.url)),
  {
    react: {
      useEffect: (effect: () => void | (() => void)) => effect(),
      useMemo: (factory: () => unknown) => factory(),
      useState: () => [
        currentDisplayMode,
        (nextMode: string | ((current: string) => string)) => {
          currentDisplayMode = typeof nextMode === 'function'
            ? nextMode(currentDisplayMode)
            : nextMode;
        },
      ],
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
        locale: 'zh',
        t: (key: string) => translations[key] || key,
      }),
    },
    './contractMarketSourceStatus': {
      getContractDomainStatusLabel: () => '\u76d8\u53e3\u6765\u6e90: \u5b9e\u65f6',
      getContractMarketSourceLabel: () => '\u5b9e\u65f6',
      getContractMarketSourceTone: () => 'realtime',
      getContractMarketSourceToneClass: () => 'realtime',
    },
    './contractOrderBook.utils': utilsModule,
    './hooks/contractMarketStoreAdapter': {
      useContractOrderBookStoreSnapshot: () => orderBookStoreSnapshot,
    },
  },
);

const ContractFuturesOrderBook = componentModule.default as (
  props: Record<string, unknown>,
) => unknown;

const asks = [
  { price: '101', amount: '5' },
  { price: '102', amount: '1' },
];
const bids = [
  { price: '99', amount: '3' },
  { price: '98', amount: '1' },
];

const baseProps = {
  pricePrecision: 2,
  bids,
  asks,
  centerPrice: '100',
  centerPriceReady: true,
  centerPriceSource: 'LIVE_MID',
  depthMode: 'FULL_DEPTH',
  depthSource: 'LIVE_WS',
  depthFreshness: 'LIVE',
};

function makeStoreDepthSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT_PERP',
    bids: [
      { price: '100', amount: '3' },
      { price: '99', amount: '1' },
    ],
    asks: [
      { price: '101', amount: '5' },
      { price: '102', amount: '1' },
    ],
    bestBid: '100',
    bestAsk: '101',
    spread: '1',
    midpoint: '100.5',
    depthMode: 'FULL_DEPTH',
    marketStatus: 'OPEN',
    executable: true,
    source: 'LIVE_WS',
    freshness: 'LIVE',
    provider: 'BINANCE_USDM',
    providerGeneration: 8,
    revision: { epoch: 8, sequence: 20, isClosed: null, checksum: null },
    stale: false,
    observedAtMs: 1_720_000_000_100,
    ...overrides,
  };
}

function renderOrderBook(overrides: Record<string, unknown> = {}) {
  return ContractFuturesOrderBook({ ...baseProps, ...overrides });
}

function walk(node: unknown): RenderNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(walk);
  if (typeof node !== 'object') return [];
  const renderNode = node as RenderNode;
  return [renderNode, ...walk(renderNode.props?.children)];
}

function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return textContent((node as RenderNode).props?.children);
}

function findByTestId(tree: unknown, testId: string) {
  const found = walk(tree).find((node) => node.props['data-testid'] === testId);
  assert.ok(found, `Expected data-testid=${testId}`);
  return found;
}

function findButton(tree: unknown, ariaLabel: string) {
  const found = walk(tree).find((node) => (
    node.type === 'button' && node.props['aria-label'] === ariaLabel
  ));
  assert.ok(found, `Expected button aria-label=${ariaLabel}`);
  return found;
}

function resetDisplayMode() {
  currentDisplayMode = 'FULL';
  orderBookStoreSnapshot = null;
}

test('FULL mode renders asks, MarketView center price, bids, and real-depth ratio', () => {
  resetDisplayMode();
  const tree = renderOrderBook();

  assert.equal(findButton(tree, '\u5168\u90e8').props['aria-pressed'], true);
  assert.match(textContent(tree), /101\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-display-price')), '100.00');
  assert.match(textContent(tree), /99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '40.00%');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '60.00%');
});

test('BUY mode renders only bids and suppresses the depth ratio', () => {
  resetDisplayMode();
  findButton(renderOrderBook(), '\u4e70\u76d8').props.onClick();
  const tree = renderOrderBook();

  assert.doesNotMatch(textContent(tree), /101\.00/);
  assert.equal(walk(tree).some((node) => (
    node.props['data-testid'] === 'contract-orderbook-display-price'
  )), false);
  assert.match(textContent(tree), /99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '--');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '--');
});

test('SELL mode renders only asks and suppresses the depth ratio', () => {
  resetDisplayMode();
  findButton(renderOrderBook(), '\u5356\u76d8').props.onClick();
  const tree = renderOrderBook();

  assert.match(textContent(tree), /101\.00/);
  assert.doesNotMatch(textContent(tree), /99\.00/);
  assert.equal(walk(tree).some((node) => (
    node.props['data-testid'] === 'contract-orderbook-display-price'
  )), false);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '--');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '--');
});

test('BBO_ONLY keeps its hint and never publishes a market-depth ratio', () => {
  resetDisplayMode();
  const tree = renderOrderBook({ depthMode: 'BBO_ONLY' });

  assert.equal(
    textContent(findByTestId(tree, 'contract-orderbook-depth-mode-label')),
    '\u6a21\u62df\u76d8\u53e3',
  );
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '--');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '--');
});

test('SYNTHETIC_FROM_BBO keeps its hint and never publishes a market-depth ratio', () => {
  resetDisplayMode();
  const tree = renderOrderBook({ depthMode: 'SYNTHETIC_FROM_BBO' });

  assert.equal(
    textContent(findByTestId(tree, 'contract-orderbook-depth-mode-label')),
    '\u4ec5\u6700\u4f73\u4e70\u5356\u4ef7',
  );
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '--');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '--');
});

test('incomplete depth uses placeholder rows without changing side height', () => {
  resetDisplayMode();
  const tree = renderOrderBook({ bids: bids.slice(0, 1), asks: asks.slice(0, 1) });
  const placeholders = walk(tree).filter((node) => (
    node.props['data-testid'] === 'contract-orderbook-placeholder'
  ));

  assert.equal(placeholders.length, 16);
  assert.equal(
    findByTestId(tree, 'contract-orderbook-ask-rows').props.style.gridTemplateRows,
    'repeat(9, minmax(0, 1fr))',
  );
  assert.equal(
    findByTestId(tree, 'contract-orderbook-bid-rows').props.style.gridTemplateRows,
    'repeat(9, minmax(0, 1fr))',
  );
});

test('loading a replacement symbol removes previous rows and keeps fixed placeholders', () => {
  resetDisplayMode();
  const previousTree = renderOrderBook();
  assert.match(textContent(previousTree), /101\.00/);
  assert.match(textContent(previousTree), /99\.00/);

  const loadingTree = renderOrderBook({ loading: true });
  const placeholders = walk(loadingTree).filter((node) => (
    node.props['data-testid'] === 'contract-orderbook-placeholder'
  ));

  assert.doesNotMatch(textContent(loadingTree), /101\.00/);
  assert.doesNotMatch(textContent(loadingTree), /99\.00/);
  assert.equal(placeholders.length, 18);
  assert.equal(textContent(findByTestId(loadingTree, 'contract-orderbook-empty-state')), '\u52a0\u8f7d\u4e2d');
});

test('symbol-switch loading guard does not render the previous active Store depth', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot();
  const tree = renderOrderBook({ bids: [], asks: [], loading: true });

  assert.doesNotMatch(textContent(tree), /101\.00|99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-empty-state')), '\u52a0\u8f7d\u4e2d');
  assert.equal((tree as RenderNode).props['data-market-authority'], 'LEGACY_FALLBACK');
});

test('MarketView unavailable state never reuses the previous frame or publishes a ratio', () => {
  resetDisplayMode();
  const tree = renderOrderBook({
    bids: [],
    asks: [],
    status: 'UNAVAILABLE',
    statusLabel: '\u884c\u60c5\u6682\u4e0d\u53ef\u7528',
    depthFreshness: 'STALE',
  });

  assert.doesNotMatch(textContent(tree), /101\.00/);
  assert.doesNotMatch(textContent(tree), /99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-empty-state')), '\u5e02\u573a\u6570\u636e\u4e0d\u53ef\u7528');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '--');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '--');
});

test('clicking a real depth price still triggers fill-price selection', () => {
  resetDisplayMode();
  const selected: string[] = [];
  const tree = renderOrderBook({
    onPriceClick: (price: string) => selected.push(price),
  });
  const bidRow = walk(findByTestId(tree, 'contract-orderbook-bid-rows'))
    .find((node) => node.type === 'button' && textContent(node).includes('99.00'));

  assert.ok(bidRow);
  bidRow.props.onClick();
  assert.deepEqual(selected, ['99']);
});

test('ratio rejects best-bid/best-ask-only evidence even when mislabeled FULL_DEPTH', () => {
  assert.equal(utilsModule.calculateContractOrderBookDepthRatio({
    bids: bids.slice(0, 1),
    asks: asks.slice(0, 1),
    displayMode: 'FULL',
    depthMode: 'FULL_DEPTH',
  }), null);
});

test('placeholder alignment is deterministic', () => {
  const row = {
    rawPrice: '99',
    price: 99,
    amount: 1,
    total: 1,
    widthPercent: 100,
  };

  assert.deepEqual(utilsModule.padContractOrderBookRows([row], 'top', 3), [row, null, null]);
  assert.deepEqual(utilsModule.padContractOrderBookRows([row], 'bottom', 3), [null, null, row]);
});

test('OrderBook reads Store depth first and emits a structured legacy diff', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot();
  const diffLogs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => diffLogs.push(args);

  try {
    const tree = renderOrderBook();
    assert.match(textContent(tree), /100\.00/);
    assert.doesNotMatch(textContent(findByTestId(tree, 'contract-orderbook-bid-rows')), /98\.00/);
    assert.equal(textContent(findByTestId(tree, 'contract-orderbook-display-price')), '100.50');
    assert.equal((tree as RenderNode).props['data-market-authority'], 'STORE');
    assert.equal((tree as RenderNode).props['data-market-symbol'], 'BTCUSDT_PERP');
    assert.equal((tree as RenderNode).props['data-provider-generation'], 8);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(diffLogs.length, 1);
  assert.equal(diffLogs[0][0], '[contract-orderbook-depth-diff]');
  const payload = diffLogs[0][1] as { differences: Array<{ field: string }> };
  assert.ok(payload.differences.some((difference) => difference.field === 'bids'));
  assert.ok(payload.differences.some((difference) => difference.field === 'bestBid'));
  assert.ok(payload.differences.some((difference) => difference.field === 'spread'));
});

test('authoritative empty Store depth does not fall back to legacy rows', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot({
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    spread: null,
    midpoint: null,
  });
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    const tree = renderOrderBook();
    assert.doesNotMatch(textContent(tree), /101\.00|99\.00|98\.00/);
    assert.equal(
      textContent(findByTestId(tree, 'contract-orderbook-empty-state')),
      '\u6682\u65e0\u76d8\u53e3\u6570\u636e',
    );
    assert.equal((tree as RenderNode).props['data-market-authority'], 'STORE');
  } finally {
    console.info = originalInfo;
  }
});
