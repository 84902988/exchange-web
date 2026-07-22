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

class FakeClock {
  now = 0;
  nextId = 1;
  tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.now + Math.max(delay, 0), callback });
    return id;
  };

  clearTimeout = (id: number) => {
    this.tasks.delete(id);
  };

  advanceBy(milliseconds: number) {
    const target = this.now + milliseconds;
    while (true) {
      const next = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

const translations: Record<string, string> = {
  perpetual: '\u6c38\u7eed',
  tradeStatus: '\u4ea4\u6613\u72b6\u6001',
  markPrice: '\u6807\u8bb0\u4ef7\u683c',
  indexPrice: '\u6307\u6570\u4ef7\u683c',
  spread: '\u4ef7\u5dee',
  spreadFloating: '\u6d6e\u52a8',
};

const Fragment = Symbol('Fragment');
const clock = new FakeClock();
let flashState = false;
let effectCursor = 0;
let refCursor = 0;
let effectStates: Array<{
  deps: unknown[];
  cleanup?: () => void;
}> = [];
let refStates: Array<{ current: unknown }> = [];
let storeSnapshotsBySymbol: Record<string, Record<string, unknown> | null> = {};

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

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  },
});

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { title: 'Royal Exchange' },
});

const headerChangeModule = loadTypeScriptModule(
  fileURLToPath(new URL('./contractHeaderChange.ts', import.meta.url)),
  {},
);

const headerModule = loadTypeScriptModule(
  fileURLToPath(new URL('./ContractMarketHeader.tsx', import.meta.url)),
  {
    react: {
      useEffect: (
        effect: () => void | (() => void),
        deps: unknown[],
      ) => {
        const index = effectCursor;
        effectCursor += 1;
        const previous = effectStates[index];
        const unchanged = previous
          && previous.deps.length === deps.length
          && deps.every((dependency, dependencyIndex) => dependency === previous.deps[dependencyIndex]);
        if (unchanged) return;
        previous?.cleanup?.();
        effectStates[index] = {
          deps: [...deps],
          cleanup: effect() || undefined,
        };
      },
      useMemo: (factory: () => unknown) => factory(),
      useRef: (initialValue: unknown) => {
        const index = refCursor;
        refCursor += 1;
        refStates[index] ??= { current: initialValue };
        return refStates[index];
      },
      useState: () => [
        flashState,
        (nextValue: boolean | ((current: boolean) => boolean)) => {
          flashState = typeof nextValue === 'function'
            ? nextValue(flashState)
            : nextValue;
        },
      ],
    },
    'react/jsx-runtime': {
      Fragment,
      jsx: createRenderNode,
      jsxs: createRenderNode,
    },
    '@/contexts/LocaleContext': {
      useLocaleContext: () => ({
        locale: 'zh',
        t: (key: string) => translations[key] || key,
      }),
    },
    './hooks/contractMarketStoreAdapter': {
      useContractHeaderStoreSnapshot: (symbol: string) => storeSnapshotsBySymbol[symbol] ?? null,
    },
    './contractHeaderChange': headerChangeModule,
    './contractMarketSourceStatus': {
      getContractTickerDomainStatusLabel: () => '\u884c\u60c5\u6765\u6e90: \u5b9e\u65f6',
    },
  },
);

const ContractMarketHeader = headerModule.default as (
  props: Record<string, unknown>,
) => unknown;

const baseProps = {
  marketSymbol: 'BTCUSDT_PERP',
  displayPrice: '64,000.0',
  change: '+640.0 / +1.00%',
  quoteStatusLabel: '\u5b9e\u65f6',
  quoteStatusTone: 'live',
  marketStatus: 'OPEN',
  marketSessionType: 'REGULAR',
  executable: true,
  tickerSource: 'LIVE_WS',
  tickerFreshness: 'LIVE',
  priceDirection: 'flat',
  displayPriceSource: 'LIVE_MID',
  displayPriceLabel: '\u4e2d\u95f4\u4ef7',
  markPrice: '63,998.0',
  indexPrice: '63,997.0',
  fundingRate: '+0.0100%',
  bestBid: '63,999.0',
  bestAsk: '64,001.0',
  spread: '2.0',
  highLow24h: '65,000.0 / 63,000.0',
  volumeTurnover24h: '100.00 / 6.40M',
};

function makeReferencePrice(
  value: number | null,
  overrides: Record<string, unknown> = {},
) {
  const usable = value !== null;
  return {
    value,
    domain: usable ? 'TRADES' : 'UNAVAILABLE',
    source: usable ? 'CONTRACT_TRADES' : null,
    provider: usable ? 'BINANCE_USDM' : null,
    freshness: usable ? 'LIVE' : null,
    eventTimeMs: usable ? 1_720_000_000_000 : null,
    receivedAtMs: usable ? 1_720_000_000_100 : null,
    generation: usable ? 9 : null,
    revision: usable ? { epoch: 9, sequence: 12, isClosed: false, checksum: null } : null,
    usable,
    rejectReason: usable ? null : 'REFERENCE_PRICE_UNAVAILABLE',
    symbol: 'BTCUSDT_PERP',
    interval: '1m',
    role: usable ? 'LAST_TRADE' : 'UNAVAILABLE',
    ...overrides,
  };
}

function makeStoreSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT_PERP',
    displayPrice: '64000',
    displayPriceSource: 'LIVE_MID',
    markPrice: '63998',
    indexPrice: '63997',
    fundingRate: '0.0001',
    bestBid: '63999',
    bestAsk: '64001',
    spread: '2',
    priceChange24h: null,
    priceChangePercent24h: null,
    high24h: null,
    low24h: null,
    baseVolume24h: null,
    quoteVolume24h: null,
    displayState: 'LIVE_TRADABLE',
    marketStatus: 'OPEN',
    marketSessionType: 'REGULAR',
    executable: true,
    source: 'LIVE_WS',
    freshness: 'LIVE',
    provider: 'BINANCE_USDM',
    providerGeneration: 9,
    revision: { epoch: 9, sequence: 12, isClosed: false, checksum: null },
    stale: false,
    observedAtMs: 1_720_000_000_100,
    ...overrides,
  };
}

function resetHarness() {
  for (const state of effectStates) state.cleanup?.();
  effectStates = [];
  effectCursor = 0;
  refStates = [];
  refCursor = 0;
  storeSnapshotsBySymbol = {};
  flashState = false;
  document.title = 'Royal Exchange';
  clock.now = 0;
  clock.nextId = 1;
  clock.tasks.clear();
}

function renderHeader(overrides: Record<string, unknown> = {}) {
  effectCursor = 0;
  refCursor = 0;
  return ContractMarketHeader({ ...baseProps, ...overrides });
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

function findByClassToken(tree: unknown, token: string) {
  const found = walk(tree).find((node) => (
    typeof node.props.className === 'string' && node.props.className.includes(token)
  ));
  assert.ok(found, `Expected class token=${token}`);
  return found;
}

test('tradfi Header keeps all seven metric cards on one xl laptop row', () => {
  resetHarness();
  const tree = renderHeader({ isTradfi: true });
  const metrics = findByClassToken(
    tree,
    'xl:grid-cols-[1.05fr_0.9fr_0.75fr_1.3fr_1.35fr_0.85fr_0.85fr]',
  );

  assert.match(metrics.props.className, /md:grid-cols-4/);
  assert.doesNotMatch(metrics.props.className, /2xl:grid-cols-7/);
});

test('crypto Header keeps seven visible metric cards on one xl laptop row without redundant index or funding cards', () => {
  resetHarness();
  const tree = renderHeader();
  const metrics = findByClassToken(tree, 'xl:grid-cols-7');
  const metricTestIds = (Array.isArray(metrics.props.children)
    ? metrics.props.children.flat(Infinity)
    : [metrics.props.children])
    .map((node) => (node as RenderNode | null)?.props?.['data-testid'])
    .filter((value): value is string => typeof value === 'string');

  assert.equal(metricTestIds.length, 7);
  assert.equal(metricTestIds.includes('contract-header-funding-rate'), false);
  assert.equal(metricTestIds.includes('contract-header-index-price'), false);
});

test('Header renders the last-trade reference price as its only main price', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({ displayPrice: '777.77' });
  const tree = renderHeader({
    referencePrice: makeReferencePrice(123.45),
    pricePrecision: 2,
    chartClose: '999.99',
    depthMid: '888.88',
  });
  const mainPrice = findByTestId(tree, 'contract-header-display-price');

  assert.equal(textContent(mainPrice), '123.45');
  assert.equal(mainPrice.props['data-display-source'], 'CONTRACT_TRADES');
  assert.equal(mainPrice.props['data-reference-role'], 'LAST_TRADE');
  assert.doesNotMatch(textContent(tree), /999\.99|888\.88|777\.77/);
});

test('Header accepts the legacy page price contract when referencePrice wiring is absent', () => {
  resetHarness();
  const tree = renderHeader({
    referencePrice: undefined,
    displayPrice: '64,321.5',
    displayPriceSource: 'TRADE_TICK',
    displayPriceLabel: '\u6700\u65b0\u6210\u4ea4',
    tickerFreshness: 'LIVE',
  });
  const mainPrice = findByTestId(tree, 'contract-header-display-price');

  assert.equal(textContent(mainPrice), '64,321.5');
  assert.equal(mainPrice.props['data-display-source'], 'TRADE_TICK');
  assert.equal(mainPrice.props['data-display-freshness'], 'LIVE');
  assert.equal(mainPrice.props['data-reference-role'], '');
  assert.equal(mainPrice.props.title, '\u6700\u65b0\u6210\u4ea4');
});

test('Header recovers live structure and BBO from the complete same-symbol page authority', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({
    displayPrice: '1',
    displayPriceSource: 'TRADE_TICK',
    displayState: 'UNAVAILABLE',
    marketStatus: 'UNKNOWN',
    marketSessionType: null,
    executable: false,
    bestBid: '1',
    bestAsk: '2',
    spread: '1',
    source: 'STALE_SNAPSHOT',
    freshness: 'RECENT',
  });
  const tree = renderHeader({
    referencePrice: makeReferencePrice(64_000),
  });

  assert.equal(
    textContent(findByTestId(tree, 'contract-header-market-status')),
    '\u5b9e\u65f6\u00b7\u4ea4\u6613\u4e2d',
  );
  assert.equal(
    textContent(findByTestId(tree, 'contract-header-best-bid')),
    '\u4e70\u4e0063,999.0',
  );
  assert.equal(
    textContent(findByTestId(tree, 'contract-header-best-ask')),
    '\u5356\u4e0064,001.0',
  );
});

test('Header does not promote a live midpoint when last trade is unavailable', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({ displayPrice: '101' });
  const tree = renderHeader({
    referencePrice: makeReferencePrice(null),
    displayPrice: '101.0',
    displayPriceSource: 'LIVE_MID',
    depthMid: '101.0',
  });
  const mainPrice = findByTestId(tree, 'contract-header-display-price');

  assert.equal(textContent(mainPrice), '--');
  assert.equal(mainPrice.props['data-reference-role'], 'UNAVAILABLE');
  assert.doesNotMatch(textContent(tree), /101\.0/);
});

test('Header displays a closed-market Kline fallback with the KLINE_CLOSE role', () => {
  resetHarness();
  const tree = renderHeader({
    referencePrice: makeReferencePrice(99, {
      domain: 'KLINE',
      source: 'CONTRACT_KLINE',
      freshness: 'HISTORICAL',
      role: 'KLINE_CLOSE',
    }),
    pricePrecision: 1,
    quoteStatusLabel: '\u95ed\u5e02\u4e2d',
    quoteStatusTone: 'unavailable',
    marketStatus: 'CLOSED',
    executable: false,
  });
  const mainPrice = findByTestId(tree, 'contract-header-display-price');

  assert.equal(textContent(mainPrice), '99.0');
  assert.equal(mainPrice.props['data-reference-role'], 'KLINE_CLOSE');
  assert.equal(mainPrice.props['data-display-source'], 'CONTRACT_KLINE');
});

test('closed market keeps provider last price visible when reference evidence is unavailable', () => {
  resetHarness();
  const tree = renderHeader({
    referencePrice: makeReferencePrice(null),
    displayPrice: '327.50',
    displayPriceSource: 'TRADE_TICK',
    displayPriceLabel: '\u6700\u65b0\u6210\u4ea4',
    tickerFreshness: 'LAST_VALID',
    quoteStatusLabel: '\u76d8\u540e',
    quoteStatusTone: 'unavailable',
    marketStatus: 'CLOSED',
    marketSessionType: 'AFTER_HOURS',
    executable: false,
  });
  const mainPrice = findByTestId(tree, 'contract-header-display-price');

  assert.equal(textContent(mainPrice), '327.50');
  assert.equal(mainPrice.props['data-reference-role'], '');
  assert.equal(mainPrice.props['data-display-source'], 'TRADE_TICK');
  assert.equal(mainPrice.props['data-display-freshness'], 'LAST_VALID');
  assert.equal(
    textContent(findByTestId(tree, 'contract-header-market-status')),
    '\u76d8\u540e\u00b7\u4e0d\u53ef\u4ea4\u6613',
  );
});

test('open market does not bypass unavailable reference evidence with a display fallback', () => {
  resetHarness();
  const tree = renderHeader({
    referencePrice: makeReferencePrice(null),
    displayPrice: '327.50',
    marketStatus: 'OPEN',
    marketSessionType: 'REGULAR',
    executable: false,
  });

  assert.equal(textContent(findByTestId(tree, 'contract-header-display-price')), '--');
});

test('Header keeps the reference main price separate from contract product metrics', () => {
  resetHarness();
  const tree = renderHeader({
    referencePrice: makeReferencePrice(100),
    pricePrecision: 1,
    markPrice: '120.0',
    indexPrice: '121.0',
    fundingRate: '+0.0200%',
  });

  assert.equal(textContent(findByTestId(tree, 'contract-header-display-price')), '100.0');
  assert.equal(textContent(findByTestId(tree, 'contract-header-mark-price')), '\u6807\u8bb0\u4ef7\u683c120.0');
  assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-index-price'), false);
  assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-funding-rate'), false);
});

test('TradFi header can label the platform midpoint as valuation price', () => {
  resetHarness();
  const tree = renderHeader({
    markPrice: '120.0',
    markPriceLabel: '\u4f30\u503c\u4ef7\u683c',
  });

  assert.equal(textContent(findByTestId(tree, 'contract-header-mark-price')), '\u4f30\u503c\u4ef7\u683c120.0');
});

test('priceDirection applies up, down, and flat main-price colors', () => {
  const cases = [
    ['up', 'text-[#00c087]'],
    ['down', 'text-[#f6465d]'],
    ['flat', 'text-white'],
  ];

  for (const [priceDirection, expectedClass] of cases) {
    resetHarness();
    const price = findByTestId(renderHeader({ priceDirection }), 'contract-header-display-price');
    assert.match(price.props.className, new RegExp(expectedClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('price changes use a direction-colored 320ms flash and scale feedback', () => {
  resetHarness();
  const initialPrice = findByTestId(
    renderHeader({ displayPrice: '100.00', priceDirection: 'up' }),
    'contract-header-display-price',
  );
  assert.doesNotMatch(initialPrice.props.className, /bg-\[#00c087\]\/10/);

  clock.advanceBy(0);
  const flashingPrice = findByTestId(
    renderHeader({ displayPrice: '100.00', priceDirection: 'up' }),
    'contract-header-display-price',
  );
  assert.match(flashingPrice.props.className, /bg-\[#00c087\]\/10/);
  assert.match(flashingPrice.props.className, /scale-\[1\.02\]/);

  clock.advanceBy(320);
  const settledPrice = findByTestId(
    renderHeader({ displayPrice: '100.00', priceDirection: 'up' }),
    'contract-header-display-price',
  );
  assert.doesNotMatch(settledPrice.props.className, /bg-\[#00c087\]\/10/);
  assert.match(settledPrice.props.className, /scale-100/);
});

test('authoritative MarketView labels map PRE_MARKET, REGULAR, AFTER_HOURS, CLOSED, and HOLIDAY', () => {
  const cases = [
    [{ quoteStatusLabel: '\u76d8\u524d', quoteStatusTone: 'unavailable', executable: false }, '\u76d8\u524d\u00b7\u4e0d\u53ef\u4ea4\u6613', 'pre_market'],
    [{ quoteStatusLabel: '\u5b9e\u65f6', quoteStatusTone: 'live', executable: true }, '\u5b9e\u65f6\u00b7\u4ea4\u6613\u4e2d', 'live'],
    [{ quoteStatusLabel: '\u76d8\u540e', quoteStatusTone: 'unavailable', executable: false }, '\u76d8\u540e\u00b7\u4e0d\u53ef\u4ea4\u6613', 'after_hours'],
    [{ quoteStatusLabel: '\u95ed\u5e02\u4e2d', quoteStatusTone: 'unavailable', executable: false }, '\u95ed\u5e02\u4e2d\u00b7\u4e0d\u53ef\u4ea4\u6613', 'closed'],
    [{ quoteStatusLabel: '\u4f11\u5e02\u4e2d', quoteStatusTone: 'unavailable', executable: false }, '\u4f11\u5e02\u4e2d\u00b7\u4e0d\u53ef\u4ea4\u6613', 'holiday'],
  ] as const;

  for (const [overrides, expectedLabel, expectedState] of cases) {
    resetHarness();
    const status = findByTestId(renderHeader(overrides), 'contract-header-market-status');
    assert.equal(textContent(status), expectedLabel);
    assert.equal(status.props['data-market-state'], expectedState);
  }
});

test('initial market bootstrap renders loading instead of a false unavailable state', () => {
  resetHarness();
  const tree = renderHeader({
    displayPrice: '--',
    quoteStatusLabel: '行情加载中',
    quoteStatusTone: 'loading',
    marketStatus: null,
    marketSessionType: null,
    executable: null,
  });
  const status = findByTestId(tree, 'contract-header-market-status');

  assert.equal(textContent(status), '加载中·等待行情');
  assert.equal(status.props['data-market-state'], 'loading');
  assert.match(findByTestId(tree, 'contract-header-market-status-dot').props.className, /animate-pulse/);
});

test('initial Store unavailable snapshot preserves the bounded page loading state', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({
    displayState: 'UNAVAILABLE',
    marketStatus: 'UNKNOWN',
    executable: false,
    bestBid: null,
    bestAsk: null,
    freshness: 'MISSING',
  });
  const tree = renderHeader({
    displayPrice: '--',
    quoteStatusLabel: '行情加载中',
    quoteStatusTone: 'loading',
    marketStatus: null,
    marketSessionType: null,
    executable: null,
  });
  const status = findByTestId(tree, 'contract-header-market-status');

  assert.equal(textContent(status), '加载中·等待行情');
  assert.equal(status.props['data-market-state'], 'loading');
});

test('unavailable price/status renders only the user-facing unavailable state', () => {
  resetHarness();
  const tree = renderHeader({
    displayPrice: '--',
    quoteStatusLabel: 'LAST_GOOD_BBO',
    quoteStatusTone: 'unavailable',
    tickerSource: 'FALLBACK',
    tickerFreshness: 'STALE',
    marketStatus: 'UNKNOWN',
    marketSessionType: null,
    executable: false,
  });
  const status = findByTestId(tree, 'contract-header-market-status');

  assert.equal(textContent(status), '\u884c\u60c5\u6682\u4e0d\u53ef\u7528\u00b7\u4e0d\u53ef\u4ea4\u6613');
  assert.doesNotMatch(textContent(tree), /LAST_GOOD_BBO|FALLBACK|STALE/);
});

test('contract metrics remain separate cards without duplicating main price', () => {
  resetHarness();
  const tree = renderHeader();

  assert.equal(textContent(findByTestId(tree, 'contract-header-mark-price')), '\u6807\u8bb0\u4ef7\u683c63,998.0');
  assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-index-price'), false);
  assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-funding-rate'), false);
  assert.equal(textContent(findByTestId(tree, 'contract-header-best-bid')), '\u4e70\u4e0063,999.0');
  assert.equal(textContent(findByTestId(tree, 'contract-header-best-ask')), '\u5356\u4e0064,001.0');
  assert.equal(textContent(findByTestId(tree, 'contract-header-spread')), '\u4ef7\u5dee\u6d6e\u52a8');
  assert.equal(textContent(findByTestId(tree, 'contract-header-high-low-24h')), 'highLow24h65,000.0 / 63,000.0');
  assert.equal(textContent(findByTestId(tree, 'contract-header-volume-turnover-24h')), 'volume24h / turnover24h100.00 / 6.40M');
  assert.equal(textContent(tree).split('64,000.0').length - 1, 1);
});

test('TradFi header omits synthetic funding/index metrics and places executable BBO cards last', () => {
  resetHarness();
  const tree = renderHeader({ isTradfi: true });
  const metricTestIds = walk(tree)
    .map((node) => node.props['data-testid'])
    .filter((value): value is string => typeof value === 'string' && value.startsWith('contract-header-'));

  assert.equal(metricTestIds.includes('contract-header-funding-rate'), false);
  assert.equal(metricTestIds.includes('contract-header-index-price'), false);
  assert.deepEqual(metricTestIds.slice(-2), [
    'contract-header-best-bid',
    'contract-header-best-ask',
  ]);
  assert.equal(textContent(findByTestId(tree, 'contract-header-best-bid')), '\u4e70\u4e0063,999.0');
  assert.equal(textContent(findByTestId(tree, 'contract-header-best-ask')), '\u5356\u4e0064,001.0');
});

test('Header reads display and mark prices from Store while retaining index price in structured diff diagnostics', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({
    displayPrice: '64010',
    markPrice: '64008',
    indexPrice: '64007',
    providerGeneration: 10,
  });
  const diffLogs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => diffLogs.push(args);

  try {
    const tree = renderHeader();
    assert.equal(textContent(findByTestId(tree, 'contract-header-display-price')), '64,010.0');
    assert.equal(textContent(findByTestId(tree, 'contract-header-mark-price')), '\u6807\u8bb0\u4ef7\u683c64,008.0');
    assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-index-price'), false);
    assert.equal((tree as RenderNode).props['data-market-authority'], 'STORE');
    assert.equal((tree as RenderNode).props['data-provider-generation'], 10);
  } finally {
    console.info = originalInfo;
  }

  assert.equal(diffLogs.length, 1);
  assert.equal(diffLogs[0][0], '[contract-header-market-diff]');
  const payload = diffLogs[0][1] as { differences: Array<{ field: string }> };
  assert.deepEqual(
    payload.differences.map((difference) => difference.field).slice(0, 3),
    ['displayPrice', 'markPrice', 'indexPrice'],
  );
});

test('Header keeps old-hook field fallback when Store has not hydrated that field', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({
    displayPrice: '64010',
    markPrice: null,
    indexPrice: null,
  });
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    const tree = renderHeader();
    assert.equal(textContent(findByTestId(tree, 'contract-header-display-price')), '64,010.0');
    assert.equal(textContent(findByTestId(tree, 'contract-header-mark-price')), '\u6807\u8bb0\u4ef7\u683c63,998.0');
    assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-index-price'), false);
  } finally {
    console.info = originalInfo;
  }
});

test('Header keeps the complete legacy fallback while Store is safely empty', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({
    displayPrice: null,
    displayPriceSource: null,
    markPrice: null,
    indexPrice: null,
    fundingRate: null,
    bestBid: null,
    bestAsk: null,
    spread: null,
    displayState: null,
    marketStatus: null,
    marketSessionType: null,
    executable: null,
    source: null,
    freshness: null,
    provider: null,
    providerGeneration: null,
    revision: null,
    observedAtMs: 0,
  });
  const diffLogs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => diffLogs.push(args);

  try {
    const tree = renderHeader();
    assert.equal(textContent(findByTestId(tree, 'contract-header-display-price')), '64,000.0');
    assert.equal(textContent(findByTestId(tree, 'contract-header-mark-price')), '\u6807\u8bb0\u4ef7\u683c63,998.0');
    assert.equal(walk(tree).some((node) => node.props['data-testid'] === 'contract-header-index-price'), false);
    assert.equal(textContent(findByTestId(tree, 'contract-header-best-bid')), '\u4e70\u4e0063,999.0');
    assert.equal(textContent(findByTestId(tree, 'contract-header-best-ask')), '\u5356\u4e0064,001.0');
    assert.equal(textContent(findByTestId(tree, 'contract-header-spread')), '\u4ef7\u5dee\u6d6e\u52a8');
  } finally {
    console.info = originalInfo;
  }

  assert.equal(diffLogs.length, 0);
});

test('Header Store selector follows marketSymbol during symbol switch', () => {
  resetHarness();
  storeSnapshotsBySymbol.BTCUSDT_PERP = makeStoreSnapshot({ displayPrice: '64000' });
  storeSnapshotsBySymbol.ETHUSDT_PERP = makeStoreSnapshot({
    symbol: 'ETHUSDT_PERP',
    displayPrice: '3500',
  });
  const originalInfo = console.info;
  console.info = () => undefined;

  try {
    const btcTree = renderHeader({ marketSymbol: 'BTCUSDT_PERP' });
    const ethTree = renderHeader({ marketSymbol: 'ETHUSDT_PERP' });
    assert.equal(textContent(findByTestId(btcTree, 'contract-header-display-price')), '64,000.0');
    assert.equal(textContent(findByTestId(ethTree, 'contract-header-display-price')), '3,500.0');
  } finally {
    console.info = originalInfo;
  }
});
