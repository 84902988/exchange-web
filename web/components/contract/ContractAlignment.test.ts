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
  expect(source).not.toContain('contractTicker');
  expect(source).toContain('selectedPriceState?.symbol === contractSymbol');
  expect(source).toContain('key={contractSymbol}');
  expect(source).toContain("setContractDataScope('current')");
  expect(source).toContain('onActiveOrdersFiltersChange({})');
  expect(source).toContain('onOrderHistoryFiltersChange({})');
  expect(source).toContain('onTradeHistoryFiltersChange({})');
  expect(source).toContain('function shouldUseInitialContractSymbol(symbol: string)');
  expect(source).toContain('return Boolean(symbol)');
  expect(source).toContain('selectorDisplayPrice = referencePrice.usable');
  expect(source).toContain('price: selectorDisplayPrice');
  expect(source).toContain('if (item.symbol !== contractSymbol || selectorDisplayPrice === null) return item;');
});

test('contract browser title follows the symbol-scoped realtime display price', () => {
  const source = readSource('components/contract/ContractMarketHeader.tsx');

  expect(source).toContain("originalDocumentTitleRef.current = document.title || 'Royal Exchange'");
  expect(source).toContain("displayPrice && displayPrice !== '--'");
  expect(source).toContain('`${titlePrice} ${displaySymbol} 合约交易 | Royal Exchange`');
  expect(source).toContain('Math.max(1000 - (now - titleUpdatedAtRef.current), 0)');
  expect(source).toContain("document.title = originalDocumentTitleRef.current || 'Royal Exchange'");
  expect(source).toContain('}, [displayPrice, displaySymbol]);');
});

test('contract chart capability classification ignores localized display groups', () => {
  const source = readSource('app/contract/page.tsx');
  const capabilityStart = source.indexOf('function getContractPairCapabilityCategories');
  const capabilityEnd = source.indexOf('function contractPairMatchesUrlCategory', capabilityStart);
  const capabilitySource = source.slice(capabilityStart, capabilityEnd);
  const tradfiStart = source.indexOf('function isTradfiContractPair');
  const tradfiEnd = source.indexOf('// Kept for future cross-market toolbar support', tradfiStart);
  const tradfiSource = source.slice(tradfiStart, tradfiEnd);

  expect(capabilitySource).toContain('pair.assetType');
  expect(capabilitySource).toContain('pair.marketCategory');
  expect(capabilitySource).toContain('pair.marketSubCategory');
  expect(capabilitySource).not.toContain('pair.displayGroup');
  expect(tradfiSource).toContain('getContractPairCapabilityCategories(pair)');
  expect(source).toContain("CONTRACT_INTERVAL_OPTIONS.filter((item) => item !== '4h')");
});

test('CFD and stock contracts hide the market-list panel and let the chart occupy both market columns', () => {
  const source = readSource('app/contract/page.tsx');
  const cfdStart = source.indexOf('function isCfdContractPair');
  const cfdEnd = source.indexOf('// Kept for future cross-market toolbar support', cfdStart);
  const cfdSource = source.slice(cfdStart, cfdEnd);
  const tradfiStart = source.indexOf('function isTradfiContractPair');
  const tradfiSource = source.slice(tradfiStart, cfdStart);

  expect(cfdSource).toContain('getContractPairCapabilityCategories(pair)');
  expect(cfdSource).toContain('CFD_CONTRACT_CATEGORIES.has(item)');
  expect(cfdSource).not.toContain('_PERP');
  expect(tradfiSource).toContain("categories.includes('STOCK')");
  expect(tradfiSource).toContain('isCfdContractPair(pair)');
  expect(source).toContain("currentContractUsesTradfiChartLayout ? 'xl:col-span-2' : ''");
  expect(source).toContain("!currentContractUsesTradfiChartLayout ? (");
  expect(source).toContain("urlContractCategory === 'cfd' || urlContractCategory === 'stock'");
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

  expect(source).toContain('resolveContractExecutionPrice({');
  expect(source).toContain("intent: 'OPEN_LONG'");
  expect(source).toContain("intent: 'OPEN_SHORT'");
  expect(source).toContain("intent: 'CLOSE_LONG'");
  expect(source).toContain("intent: 'CLOSE_SHORT'");
  expect(source).toContain("closeSide === 'LONG' ? executionPrices.closeLong : executionPrices.closeShort");
  expect(source).toContain("positionSide === 'LONG' ? executionPrices.openLong : executionPrices.openShort");
  expect(source).not.toMatch(/currentActionExecution[^;]*display_price/);
  expect(source).not.toMatch(/currentActionExecution[^;]*localChartLastClose/);
});

test('contract market view rejects stale symbol data for market, depth, trades, and errors', () => {
  const source = readSource('components/contract/hooks/useContractMarketView.ts');

  expect(source).toContain('normalizeContractSymbol(wsState?.symbol) === normalizeContractSymbol(contractSymbol)');
  expect(source).toContain('normalizeContractSymbol(restMarketView?.symbol) === normalizeContractSymbol(contractSymbol)');
  expect(source).toContain('depthBelongsToCurrentSymbol');
  expect(source).toContain('storeTradesBelongToCurrentSymbol');
  expect(source).toContain('localTradesBelongToCurrentSymbol');
  expect(source).toContain('useContractTradesStoreSnapshot()');
  expect(source).toContain('marketViewErrorSymbolRef.current === normalizeContractSymbol(contractSymbol)');
  expect(source).toContain('requestSeqRef.current !== requestSeq');
  expect(source).toContain('marketViewAbortControllerRef.current?.abort()');
});

test('BBO-only depth enters realtime authority before quantity-based rows are derived', () => {
  const source = readSource('components/contract/hooks/useContractMarketView.ts');
  const handlerStart = source.indexOf('const handleDepthMessage =');
  const handlerEnd = source.indexOf("contractMarketRealtime.subscribe('depth'", handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);

  expect(handlerStart).toBeGreaterThanOrEqual(0);
  expect(handlerEnd).toBeGreaterThan(handlerStart);
  expect(handlerSource.indexOf('ingestContractMarketWsDomain({')).toBeGreaterThanOrEqual(0);
  expect(handlerSource.indexOf('ingestContractMarketWsDomain({'))
    .toBeLessThan(handlerSource.indexOf('extractRealtimeDepth(message, contractSymbol)'));
});

test('Contract Price Authority keeps trade provenance on one evidence row', () => {
  const source = readSource('components/contract/hooks/useContractMarketView.ts');
  const authoritySection = source.slice(
    source.indexOf('const priceAuthority = useMemo'),
    source.indexOf('const referencePrice = useMemo'),
  );

  expect(authoritySection).toContain('price: latestTrade.price');
  expect(authoritySection).toContain('time: latestTrade.time');
  expect(authoritySection).toContain('source: latestTrade.source ?? latestTrade.quote_source');
  expect(authoritySection).toContain('freshness: latestTrade.quote_freshness');
  expect(authoritySection).toContain('priceSource: latestTrade.price_source');
  expect(authoritySection).toContain('synthetic: latestTrade.synthetic');
  expect(authoritySection).not.toContain('tradesState.source');
  expect(authoritySection).not.toContain('tradesState.freshness');
  expect(authoritySection).not.toContain('display_price');
  expect(authoritySection).not.toContain('mark_price');
});

test('contract header metrics reuse quote/store bootstrap without a duplicate ticker request', () => {
  const source = readSource('app/contract/page.tsx');

  expect(source).not.toContain('getContractTickers');
  expect(source).not.toContain('refreshContractTicker');
  expect(source).toContain('changeAmount: contractQuote?.price_change_24h');
  expect(source).toContain('changePercent: contractQuote?.price_change_percent_24h');
  expect(source).toContain('contractQuote?.base_volume_24h');
  expect(source).toContain('contractQuote?.quote_volume_24h');
});

test('contract header receives authoritative MarketView status and does not synthesize quote time', () => {
  const pageSource = readSource('app/contract/page.tsx');
  const headerSource = readSource('components/contract/ContractMarketHeader.tsx');
  const hookSource = readSource('components/contract/hooks/useContractMarketView.ts');

  expect(pageSource).toContain('tickerSource={tickerSource}');
  expect(pageSource).toContain('tickerFreshness={tickerFreshness}');
  expect(pageSource).toContain('executable={contractExecutable}');
  expect(pageSource).toContain('referencePrice={referencePrice}');
  expect(headerSource).toContain('quoteStatusLabel');
  expect(headerSource).toContain("data-display-freshness={displayPriceFreshness || ''}");
  expect(headerSource).toContain('resolveContractHeaderMarketPresentation({');
  expect(headerSource).not.toContain('getContractTickerDomainStatusLabel');
  expect(headerSource).not.toContain('<MarketStatusBadge');
  expect(hookSource).toContain('parseContractMarketTimestamp(marketView?.quote_time)');
  expect(hookSource).toContain(': quoteTime,');
  expect(hookSource).toContain('const displayPrice = marketViewAuthority.displayPrice;');
  expect(hookSource).not.toContain('chartLastClose');
});

test('TradingView price line shares Header reference price without mutating candles', () => {
  const pageSource = readSource('app/contract/page.tsx');
  const stockPageSource = readSource('app/markets/stocks/[symbol]/page.tsx');
  const chartSource = readSource('components/contract/ContractTradingViewChart.tsx');

  expect(pageSource).toMatch(/<ContractTradingViewChart[\s\S]*?referencePrice=\{referencePrice\}[\s\S]*?\/>/);
  expect(pageSource).not.toContain('preferReferencePriceOverlay=');
  expect(stockPageSource).not.toContain('preferReferencePriceOverlay');
  expect(chartSource).toContain('referencePrice: ContractReferencePrice;');
  expect(chartSource).not.toContain('preferReferencePriceOverlay');
  expect(chartSource).toContain('resolveContractTradingViewOverlayPrice(referencePrice, normalizedSymbol)');
  expect(chartSource).toContain('resolveContractTradingViewActiveOverlayPrice(');
  expect(chartSource).toContain('createContractTradingViewDatafeed({');
  expect(chartSource).toContain('onLatestBar: (price) => {');
  expect(chartSource).toContain('latestKlineOverlayRef.current = {');
  expect(chartSource).toContain('latestKlineOverlayRef.current.price,');
  expect(chartSource).toContain('onLatestKlineCloseChangeRef.current?.(price);');
});

test('contract TradingView and OrderBook share one referencePrice contract', () => {
  const pageSource = readSource('app/contract/page.tsx');
  const hookSource = readSource('components/contract/hooks/useContractMarketView.ts');
  const orderBookSource = readSource('components/contract/ContractFuturesOrderBook.tsx');

  expect(pageSource).toMatch(/<ContractTradingViewChart[\s\S]*?referencePrice=\{referencePrice\}[\s\S]*?\/>/);
  expect(pageSource).toMatch(/<ContractFuturesOrderBook[\s\S]*?referencePrice=\{referencePrice\}[\s\S]*?\/>/);
  expect(hookSource).toContain('price: quote?.last_price ?? fallbackLastPrice');
  expect(pageSource).not.toContain('displayOnlyPrice=');
  expect(pageSource).not.toContain('centerPrice={contractMarketState.displayPrice}');
  expect(orderBookSource).toContain('referencePrice: ContractReferencePrice;');
  expect(orderBookSource).toContain('const centerPriceNumber = referencePrice.usable');
  expect(orderBookSource).not.toContain('storeHasMidpoint');
});

test('contract Header, TradingView, and OrderBook share one reference-price direction owner', () => {
  const pageSource = readSource('app/contract/page.tsx');
  const marketStateSource = readSource('components/contract/hooks/useContractMarketState.ts');
  const marketViewSource = readSource('components/contract/hooks/useContractMarketView.ts');

  expect(pageSource).toMatch(/<ContractMarketHeader[\s\S]*?priceDirection=\{currentPriceDirection\}[\s\S]*?\/>/);
  expect(pageSource).toMatch(/<ContractMarketHeader[\s\S]*?storeSymbol=\{contractSymbol\}[\s\S]*?\/>/);
  expect(pageSource).toMatch(/<ContractTradingViewChart[\s\S]*?priceDirection=\{currentPriceDirection\}[\s\S]*?\/>/);
  expect(pageSource).toMatch(/<ContractFuturesOrderBook[\s\S]*?priceDirection=\{currentPriceDirection\}[\s\S]*?\/>/);
  expect(marketViewSource).toContain('advanceContractPriceDirection(currentState, {');
  expect(marketViewSource).toContain('price: referencePrice.usable ? referencePrice.value : null');
  expect(marketStateSource).not.toContain('setPriceDirection');
  expect(marketStateSource).not.toContain('latestMarketPriceRef');
});

test('every ContractTradingViewChart consumer provides a symbol-matched referencePrice', () => {
  const contractPageSource = readSource('app/contract/page.tsx');
  const stockPageSource = readSource('app/markets/stocks/[symbol]/page.tsx');

  expect(contractPageSource).toMatch(
    /<ContractTradingViewChart[\s\S]*?symbol=\{contractSymbol\}[\s\S]*?referencePrice=\{referencePrice\}[\s\S]*?\/>/,
  );
  expect(stockPageSource).toMatch(
    /<ContractTradingViewChart[\s\S]*?symbol=\{chartMarketSymbol\}[\s\S]*?referencePrice=\{chartReferencePrice\}[\s\S]*?\/>/,
  );
  expect(stockPageSource).toContain('const value = stats.lastPrice !== null');
  expect(stockPageSource).toContain("role: usable ? 'LAST_TRADE' : 'UNAVAILABLE'");
  expect(stockPageSource).toContain("domain: usable ? 'TRADES' : 'UNAVAILABLE'");
  expect(stockPageSource).toContain("source: usable ? 'STOCK_QUOTE_LAST_PRICE' : null");
  expect(stockPageSource).toContain("rejectReason: usable ? null : 'REFERENCE_PRICE_UNAVAILABLE'");
  expect(stockPageSource).toContain('symbol: chartMarketSymbol');
  expect(stockPageSource).not.toContain('buildContractPriceAuthority');
});

test('contract quote refreshes collapse short reconnect bursts without caching failures', () => {
  const source = readSource('components/contract/hooks/useContractMarketState.ts');

  expect(source).toContain('CONTRACT_QUOTE_REQUEST_DEDUPE_MS = 1_000');
  expect(source).toContain('if (existing?.promise) return existing.promise');
  expect(source).toContain("contractQuoteRequestStore.get(contractSymbol)?.promise !== promise");
  expect(source).toContain('contractQuoteRequestStore.delete(contractSymbol)');
  expect(source).toContain('await loadContractQuote(contractSymbol)');
});

test('contract backend reconnect rotates shared authority before replay and preserves the arriving MarketView snapshot', () => {
  const marketStateSource = readSource('components/contract/hooks/useContractMarketState.ts');
  const marketViewSource = readSource('components/contract/hooks/useContractMarketView.ts');

  expect(marketStateSource).toContain('if (transportRecovery.reconnectGeneration <= 0) return;');
  expect(marketStateSource).toContain('const recoveredConnection = (');
  expect(marketStateSource).toContain('if (recoveredConnection) {');
  expect(marketStateSource).toContain('restartContractMarketShadowSession(contractSymbol);');
  expect(marketStateSource).toContain('contractQuoteRequestStore.delete(contractSymbol);');
  expect(marketViewSource).toContain('marketViewAbortControllerRef.current?.abort();');
  const reconnectEffect = marketViewSource.slice(
    marketViewSource.indexOf('if (transportRecovery.reconnectGeneration <= 0) return;'),
    marketViewSource.indexOf('const projectedMarketViewAuthority'),
  );
  expect(reconnectEffect).not.toContain('setWsState(null);');
  expect(marketViewSource).toContain('setMarketSessionRefreshKey((value) => value + 1);');
  expect(marketViewSource).toContain('void refreshMarketView();');
});

test('closed CFD sessions keep ingesting display trades and depth while execution remains separately gated', () => {
  const marketViewSource = readSource('components/contract/hooks/useContractMarketView.ts');

  expect(marketViewSource).not.toContain("if (effectiveMarketStatus === 'CLOSED') return;");
  expect(marketViewSource).toContain("const sessionMode = effectiveMarketStatus === 'CLOSED' ? 'CLOSED' : 'ACTIVE';");
});

test('contract realtime keeps market symbol ownership separate from chart interval ownership', () => {
  const pageSource = readSource('app/contract/page.tsx');
  const marketStateSource = readSource('components/contract/hooks/useContractMarketState.ts');
  const marketViewSource = readSource('components/contract/hooks/useContractMarketView.ts');
  const datafeedSource = readSource('components/contract/tradingview/contractTradingViewDatafeed.ts');
  const realtimeSource = readSource('lib/realtime/contractMarketRealtime.ts');

  expect(pageSource).not.toContain('interval: effectiveKlineInterval,');
  expect(marketStateSource).toContain('contractMarketRealtime.setMarketSession(contractSymbol)');
  expect(marketStateSource).not.toContain('contractMarketRealtime.setSession({ symbol: contractSymbol, interval })');
  expect(marketViewSource).toContain('isContractMarketDomainMessage(message)');
  expect(datafeedSource).toContain('contractMarketRealtime.subscribeKline({');
  expect(datafeedSource).not.toContain('contractMarketRealtime.setSession(');
  expect(realtimeSource).toContain("this.sendDomainCommand('subscribe', 'market', this.marketSymbol)");
  expect(realtimeSource).toMatch(/this\.sendDomainCommand\(\s*'unsubscribe',\s*'kline'/);
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

test('contract position empty state does not draw an internal divider above the aligned panel bottom', () => {
  const source = readSource('components/contract/ContractPositionTabs.tsx');
  const emptyStateSource = source.slice(
    source.indexOf('function EmptyState'),
    source.indexOf('function withTimeout'),
  );

  expect(emptyStateSource).toContain('className="px-2 py-8 text-center"');
  expect(emptyStateSource).not.toContain('border-b');
  expect(emptyStateSource).not.toContain('border-white/10');
});

test('collapsed contract panels align while only the trading rail grows for expanded take-profit and stop-loss fields', () => {
  const source = readSource('app/contract/page.tsx');
  const formSource = readSource('components/contract/ContractTradingForm.tsx');
  const marketPanelsTestId = 'data-testid="contract-market-panels"';
  const railTestId = 'data-testid="contract-trading-account-rail"';
  const marketPanelsStart = source.indexOf(marketPanelsTestId);
  const railStart = source.indexOf(railTestId);
  const tradingFormStart = source.indexOf('<ContractTradingForm', railStart);
  const accountPanelStart = source.indexOf('<ContractAccountPanel', railStart);

  expect(source).toContain(
    'xl:grid-cols-[minmax(0,10.55fr)_minmax(260px,1.85fr)]',
  );
  expect(source).toContain(
    "isTradingTpSlExpanded ? 'xl:items-start' : 'xl:items-stretch'",
  );
  expect(source).toContain(
    'xl:grid-rows-[minmax(max(540px,62vh),max(540px,62vh))_minmax(170px,auto)] xl:items-stretch',
  );
  expect(source).toContain(
    'className="flex min-h-0 min-w-0 flex-col gap-3 xl:col-start-2 xl:row-start-1"',
  );
  expect(marketPanelsStart).toBeGreaterThan(-1);
  expect(railStart).toBeGreaterThan(-1);
  expect(railStart).toBeGreaterThan(marketPanelsStart);
  expect(tradingFormStart).toBeGreaterThan(railStart);
  expect(accountPanelStart).toBeGreaterThan(tradingFormStart);
  expect(source).toContain('onTpSlExpandedChange={handleTradingTpSlExpandedChange}');
  expect(source).toContain('ref={tradingAccountRailRef}');
  expect(source).toContain('style={collapsedTradingRailHeight ? { minHeight: `${collapsedTradingRailHeight}px` } : undefined}');
  expect(source).toContain("if (!rail || typeof ResizeObserver === 'undefined') return undefined;");
  expect(source).toContain('if (isTradingTpSlExpandedRef.current) return;');
  expect(source).toContain('const lastRailSection = rail.lastElementChild;');
  expect(source).toContain('lastRailSection.getBoundingClientRect().bottom - rail.getBoundingClientRect().top');
  expect(source).toContain('Array.from(rail.children).forEach((section) => observer.observe(section));');
  expect(formSource).toContain('onTpSlExpandedChange?: (expanded: boolean) => void;');
  expect(formSource).toContain('onTpSlExpandedChange?.(enabled);');
  expect(formSource).toContain('onChange={(event) => setTpSlEnabled(event.target.checked)}');
  expect(source).not.toContain('xl:col-start-3 xl:row-span-2 xl:row-start-1');
  expect(source).not.toContain('xl:grid-rows-[minmax(max(540px,62vh),auto)_minmax(170px,auto)]');
});
