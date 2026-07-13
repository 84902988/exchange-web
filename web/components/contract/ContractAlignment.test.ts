import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

test('contract terminal reuses the shared selector and isolates symbol-scoped presentation state', () => {
  const source = readSource('app/contract/page.tsx');

  expect(source).toContain("from '@/components/spot/GlobalMarketSelector'");
  expect(source).toContain('placement="header"');
  expect(source).toContain('normalizeContractSymbol(contractTicker.symbol) === contractSymbol');
  expect(source).toContain('selectedPriceState?.symbol === contractSymbol');
  expect(source).toContain('key={contractSymbol}');
  expect(source).toContain("setContractDataScope('current')");
  expect(source).toContain('onActiveOrdersFiltersChange({})');
  expect(source).toContain('onOrderHistoryFiltersChange({})');
  expect(source).toContain('onTradeHistoryFiltersChange({})');
  expect(source).toContain('function shouldUseInitialContractSymbol(symbol: string)');
  expect(source).toContain('return Boolean(symbol)');
});

test('contract market panels keep click-to-fill states without duplicating the symbol title', () => {
  const pageSource = readSource('app/contract/page.tsx');
  const orderBookSource = readSource('components/contract/ContractFuturesOrderBook.tsx');
  const tradesSource = readSource('components/contract/ContractFuturesTrades.tsx');

  expect(pageSource).toContain('onPriceClick={(price) => setSelectedPriceState({ symbol: contractSymbol, price })}');
  expect(orderBookSource).toContain("error ? t('marketDataUnavailable', 'contracts')");
  expect(tradesSource).toContain("error ? t('marketDataUnavailable', 'contracts')");
  expect(orderBookSource).not.toContain('displaySymbol(symbol)');
  expect(tradesSource).not.toContain('{symbol}');
});

test('contract execution prices remain direction-specific and never use display price', () => {
  const source = readSource('components/contract/ContractTradingForm.tsx');

  expect(source).toContain("closeSide === 'LONG' ? resolvedExecutionBid : resolvedExecutionAsk");
  expect(source).toContain("positionSide === 'LONG' ? resolvedExecutionAsk : resolvedExecutionBid");
  expect(source).not.toMatch(/currentActionExecutionPrice[^;]*display_price/);
  expect(source).not.toMatch(/currentActionExecutionPrice[^;]*localChartLastClose/);
});

test('contract market view rejects stale symbol data for market, depth, trades, and errors', () => {
  const source = readSource('components/contract/hooks/useContractMarketView.ts');

  expect(source).toContain('normalizeContractSymbol(wsState?.symbol) === normalizeContractSymbol(contractSymbol)');
  expect(source).toContain('normalizeContractSymbol(restMarketView?.symbol) === normalizeContractSymbol(contractSymbol)');
  expect(source).toContain('depthBelongsToCurrentSymbol');
  expect(source).toContain('tradesBelongToCurrentSymbol');
  expect(source).toContain('marketViewErrorSymbolRef.current === normalizeContractSymbol(contractSymbol)');
});

test('contract quote refreshes collapse short reconnect bursts without caching failures', () => {
  const source = readSource('components/contract/hooks/useContractMarketState.ts');

  expect(source).toContain('CONTRACT_QUOTE_REQUEST_DEDUPE_MS = 1_000');
  expect(source).toContain('if (existing?.promise) return existing.promise');
  expect(source).toContain('contractQuoteRequestStore.delete(contractSymbol)');
  expect(source).toContain('await loadContractQuote(contractSymbol)');
});

test('contract TradingView uses the current readiness API and asynchronous symbol resolution', () => {
  const chartSource = readSource('components/contract/ContractTradingViewChart.tsx');
  const datafeedSource = readSource('components/contract/tradingview/contractTradingViewDatafeed.ts');

  expect(chartSource).toContain('widget.chartReady().then(markChartReady)');
  expect(chartSource).toContain('setSpotToolbarLoadingState(toolbarSlot, toolbarButtonRefs.current, { loading: false })');
  expect(datafeedSource).toContain("window.setTimeout(() => onError('Invalid contract symbol'), 0)");
  expect(datafeedSource).toContain('window.setTimeout(() => {');
});

test('contract position tabs use the spot-style compact tab bar and reset scoped paging', () => {
  const source = readSource('components/contract/ContractPositionTabs.tsx');

  expect(source).toContain('overflow-x-auto');
  expect(source).toContain('after:bottom-[-1px]');
  expect(source).toContain("setInternalScope('current')");
  expect(source).toContain('setTabPage(activeTab, 1)');
  expect(source).toContain('[currentSymbol, onScopeChange]');
});
