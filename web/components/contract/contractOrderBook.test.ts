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

function makeReferencePrice(overrides: Record<string, unknown> = {}) {
  return {
    value: 99.8,
    domain: 'TRADES',
    source: 'TRADE_TICK',
    provider: 'OKX_SWAP',
    freshness: 'LIVE',
    eventTimeMs: 1_720_000_000_000,
    usable: true,
    rejectReason: null,
    symbol: 'BTCUSDT_PERP',
    role: 'LAST_TRADE',
    ...overrides,
  };
}

const baseProps = {
  pricePrecision: 2,
  bids,
  asks,
  referencePrice: makeReferencePrice(),
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

test('FULL mode renders asks, reference price, bids, and real-depth ratio', () => {
  resetDisplayMode();
  const tree = renderOrderBook();

  assert.equal(findButton(tree, '\u5168\u90e8').props['aria-pressed'], true);
  assert.match(textContent(tree), /101\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '99.80');
  assert.match(textContent(tree), /99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '40.00%');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '60.00%');
  assert.equal(findByTestId(tree, 'contract-orderbook-buy-ratio-bar').props.style.width, '40%');
  assert.equal(findByTestId(tree, 'contract-orderbook-sell-ratio-bar').props.style.width, '60%');
});

test('reference center keeps the large authority price and adds its direction cue', () => {
  resetDisplayMode();
  const upTree = renderOrderBook({ priceDirection: 'up' });
  const upValue = findByTestId(upTree, 'contract-orderbook-price-value');
  const upDirection = findByTestId(upTree, 'contract-orderbook-price-direction');

  assert.equal(textContent(upValue), '99.80');
  assert.match(String(upValue.props.className), /text-\[20px\]/);
  assert.equal(textContent(upDirection), '\u2191');
  assert.match(String(upDirection.props.className), /text-\[#00c087\]/);

  const downTree = renderOrderBook({ priceDirection: 'down' });
  const downDirection = findByTestId(downTree, 'contract-orderbook-price-direction');
  assert.equal(textContent(downDirection), '\u2193');
  assert.match(String(downDirection.props.className), /text-\[#f6465d\]/);

  const flatTree = renderOrderBook({ priceDirection: 'flat' });
  assert.equal(walk(flatTree).some((node) => (
    node.props['data-testid'] === 'contract-orderbook-price-direction'
  )), false);
});

test('BUY mode keeps the reference center and the aggregate two-sided depth ratio', () => {
  resetDisplayMode();
  findButton(renderOrderBook(), '\u4e70\u76d8').props.onClick();
  const tree = renderOrderBook();

  assert.doesNotMatch(textContent(tree), /101\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '99.80');
  assert.match(textContent(tree), /99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '40.00%');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '60.00%');
});

test('SELL mode keeps the reference center and the aggregate two-sided depth ratio', () => {
  resetDisplayMode();
  findButton(renderOrderBook(), '\u5356\u76d8').props.onClick();
  const tree = renderOrderBook();

  assert.match(textContent(tree), /101\.00/);
  assert.doesNotMatch(textContent(tree), /99\.00/);
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '99.80');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-buy-ratio')), '40.00%');
  assert.equal(textContent(findByTestId(tree, 'contract-orderbook-sell-ratio')), '60.00%');
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
  assert.equal(textContent(findByTestId(loadingTree, 'contract-orderbook-price-value')), '99.80');
  assert.match(String(findByTestId(loadingTree, 'contract-orderbook-display-price').props.className), /z-20/);
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
    depthMode: 'FULL_DEPTH',
  }), null);
});

test('OrderBook does not duplicate the realtime status badge inside the panel', () => {
  resetDisplayMode();
  const tree = renderOrderBook({ status: 'LIVE', statusLabel: '\u5b9e\u65f6' });

  assert.doesNotMatch(textContent(tree), /\u5b9e\u65f6/);
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

test('OrderBook reads Store depth without overriding reference price or logging each frame', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot();
  const selected: string[] = [];
  const diffLogs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => diffLogs.push(args);

  try {
    const tree = renderOrderBook({
      onPriceClick: (price: string) => selected.push(price),
    });
    const center = findByTestId(tree, 'contract-orderbook-display-price');
    assert.match(textContent(tree), /100\.00/);
    assert.doesNotMatch(textContent(findByTestId(tree, 'contract-orderbook-bid-rows')), /98\.00/);
    assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '99.80');
    assert.equal(center.props['aria-label'], '\u6700\u65b0\u4ef7');
    assert.equal(center.props['data-price-role'], 'LAST_TRADE');
    assert.equal(center.props['data-price-source'], 'TRADE_TICK');
    assert.equal(center.props['data-price-freshness'], 'LIVE');
    assert.equal(center.props['data-price-usable'], 'true');
    center.props.onClick();
    assert.deepEqual(selected, ['99.8']);
    assert.equal((tree as RenderNode).props['data-market-authority'], 'STORE');
    assert.equal((tree as RenderNode).props['data-market-symbol'], 'BTCUSDT_PERP');
    assert.equal((tree as RenderNode).props['data-provider-generation'], 8);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(diffLogs.length, 0);
});

test('realtime Store depth refreshes rows and ratio while center follows reference authority', () => {
  resetDisplayMode();
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    orderBookStoreSnapshot = makeStoreDepthSnapshot({
      bids: [{ price: '100', amount: '3' }, { price: '99', amount: '1' }],
      asks: [{ price: '101', amount: '5' }, { price: '102', amount: '1' }],
    });
    const firstTree = renderOrderBook();
    assert.equal(textContent(findByTestId(firstTree, 'contract-orderbook-buy-ratio')), '40.00%');
    assert.equal(textContent(findByTestId(firstTree, 'contract-orderbook-price-value')), '99.80');

    orderBookStoreSnapshot = makeStoreDepthSnapshot({
      bids: [{ price: '100.5', amount: '9' }, { price: '100', amount: '1' }],
      asks: [{ price: '101', amount: '1' }, { price: '101.5', amount: '1' }],
      bestBid: '100.5',
      bestAsk: '101',
      spread: '0.5',
      midpoint: '100.75',
      observedAtMs: 1_720_000_000_200,
    });
    const nextTree = renderOrderBook({
      referencePrice: makeReferencePrice({ value: 100.25, eventTimeMs: 1_720_000_000_200 }),
    });

    assert.match(textContent(findByTestId(nextTree, 'contract-orderbook-bid-rows')), /100\.50/);
    assert.equal(textContent(findByTestId(nextTree, 'contract-orderbook-buy-ratio')), '83.33%');
    assert.equal(textContent(findByTestId(nextTree, 'contract-orderbook-sell-ratio')), '16.67%');
    assert.equal(textContent(findByTestId(nextTree, 'contract-orderbook-price-value')), '100.25');
  } finally {
    console.info = originalInfo;
  }
});

test('Kline fallback reference keeps its own value, label, source, and freshness', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot();
  const selected: string[] = [];
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    const tree = renderOrderBook({
      referencePrice: makeReferencePrice({
        value: 98.75,
        domain: 'KLINE',
        source: 'KLINE_CLOSE',
        provider: 'PROVIDER_KLINE',
        freshness: 'CACHED',
        role: 'KLINE_CLOSE',
      }),
      onPriceClick: (price: string) => selected.push(price),
    });
    const center = findByTestId(tree, 'contract-orderbook-display-price');

    assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '98.75');
    assert.equal(center.props['aria-label'], 'K\u7ebf\u6700\u65b0\u4ef7');
    assert.equal(center.props['data-price-role'], 'KLINE_CLOSE');
    assert.equal(center.props['data-price-source'], 'KLINE_CLOSE');
    assert.equal(center.props['data-price-freshness'], 'CACHED');
    center.props.onClick();
    assert.deepEqual(selected, ['98.75']);
  } finally {
    console.info = originalInfo;
  }
});

test('unavailable reference disables the center while Store depth remains visible', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot();
  const selected: string[] = [];
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    const tree = renderOrderBook({
      referencePrice: makeReferencePrice({
        value: null,
        domain: 'UNAVAILABLE',
        source: null,
        provider: null,
        freshness: null,
        eventTimeMs: null,
        usable: false,
        rejectReason: 'REFERENCE_PRICE_UNAVAILABLE',
        role: 'UNAVAILABLE',
      }),
      onPriceClick: (price: string) => selected.push(price),
    });
    const center = findByTestId(tree, 'contract-orderbook-display-price');

    assert.match(textContent(findByTestId(tree, 'contract-orderbook-ask-rows')), /101\.00/);
    assert.match(textContent(findByTestId(tree, 'contract-orderbook-bid-rows')), /100\.00/);
    assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '--');
    assert.equal(center.props.disabled, true);
    assert.equal(center.props['aria-label'], '\u5e02\u573a\u6570\u636e\u4e0d\u53ef\u7528');
    assert.equal(center.props['data-price-role'], 'UNAVAILABLE');
    assert.equal(center.props['data-price-source'], '');
    assert.equal(center.props['data-price-freshness'], '');
    assert.equal(center.props['data-price-usable'], 'false');
    center.props.onClick();
    assert.deepEqual(selected, []);
  } finally {
    console.info = originalInfo;
  }
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
    const emptyState = findByTestId(tree, 'contract-orderbook-empty-state');
    const center = findByTestId(tree, 'contract-orderbook-display-price');
    assert.equal(textContent(emptyState), '\u6682\u65e0\u76d8\u53e3\u6570\u636e');
    assert.equal(emptyState.props['data-empty-scope'], 'depth-side');
    assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '99.80');
    assert.match(center.props.className, /h-11 min-h-11/);
    assert.equal((tree as RenderNode).props['data-market-authority'], 'STORE');
  } finally {
    console.info = originalInfo;
  }
});

test('closed-market ticker authority keeps one selectable center reference while depth is empty', () => {
  resetDisplayMode();
  orderBookStoreSnapshot = makeStoreDepthSnapshot({
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    spread: null,
    midpoint: null,
  });
  const selected: string[] = [];
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    const tree = renderOrderBook({
      referencePrice: makeReferencePrice({
        value: 327.5,
        domain: 'TICKER',
        source: 'LAST_PRICE',
        provider: 'ITICK_QUOTE',
        freshness: 'LAST_VALID',
        eventTimeMs: 1_720_000_000_000,
        usable: true,
        rejectReason: null,
        role: 'LAST_PRICE',
      }),
      onPriceClick: (price: string) => selected.push(price),
    });
    const center = findByTestId(tree, 'contract-orderbook-display-price');

    assert.equal(textContent(findByTestId(tree, 'contract-orderbook-price-value')), '327.50');
    assert.equal(center.props.disabled, false);
    assert.equal(center.props['data-price-role'], 'LAST_PRICE');
    assert.equal(center.props['data-price-source'], 'LAST_PRICE');
    assert.equal(center.props['data-price-freshness'], 'LAST_VALID');
    assert.equal(center.props['data-price-usable'], 'true');
    assert.equal(findByTestId(tree, 'contract-orderbook-empty-state').props['data-empty-scope'], 'depth-side');
    center.props.onClick();
    assert.deepEqual(selected, ['327.5']);
  } finally {
    console.info = originalInfo;
  }
});
