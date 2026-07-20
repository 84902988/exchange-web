import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveContractSymbolUrlSyncOwnership } from './contractSymbolNavigation';

const pageSource = readFileSync(
  resolve(process.cwd(), 'app/contract/page.tsx'),
  'utf8',
);
const marketStateSource = readFileSync(
  resolve(process.cwd(), 'components/contract/hooks/useContractMarketState.ts'),
  'utf8',
);
const marketViewSource = readFileSync(
  resolve(process.cwd(), 'components/contract/hooks/useContractMarketView.ts'),
  'utf8',
);

describe('Contract TradingView bootstrap experience', () => {
  test('waits for symbol metadata before creating the only chart widget consumer', () => {
    expect(pageSource).toContain("currentContractKlineAssetClass !== 'UNKNOWN'");
    expect(pageSource).toContain('&& chartBootstrapMatchesUrlCategory;');
    expect(pageSource).not.toContain(
      'const chartBootstrapReady = contractPairsLoaded && currentContractPair !== null;',
    );
    expect(pageSource).toContain('bootstrapReady={chartBootstrapReady}');
    expect(pageSource).not.toContain('{chartBootstrapReady ? (');
    expect(pageSource.match(/<ContractTradingViewChart/g)).toHaveLength(1);
  });

  test('loads the TradingView script while metadata settles and uses catalog precision once', () => {
    expect(pageSource).toContain('amountPrecision: item.quantity_precision');
    expect(pageSource).toContain('pricePrecision={currentContractPair?.pricePrecision ?? null}');
    expect(pageSource).toContain('amountPrecision={currentContractPair?.amountPrecision ?? null}');
  });

  test('loads current symbol metadata before the full selector catalog', () => {
    const bootstrapRequestIndex = pageSource.indexOf('keyword: bootstrapSymbol');
    const catalogRequestIndex = pageSource.indexOf("loadContractSymbols({ category: 'all'");

    expect(bootstrapRequestIndex).toBeGreaterThan(-1);
    expect(catalogRequestIndex).toBeGreaterThan(bootstrapRequestIndex);
    expect(pageSource).toContain('page_size: 1');
    expect(pageSource).toContain('The full catalog remains the fail-closed metadata fallback.');
    expect(pageSource).toContain('const retryDelays = [1000, 2000, 5000, 10000]');
    expect(pageSource).toContain('if (disposed || loaded) return;');
    expect(pageSource).toContain('const contractSymbolRequestStore = new Map<string, ContractSymbolRequestEntry>();');
  });

  test('gives authoritative realtime a bootstrap grace before REST fallbacks', () => {
    expect(marketStateSource).toContain('CONTRACT_QUOTE_REST_BOOTSTRAP_GRACE_MS');
    expect(marketStateSource).toContain("if (marketRealtimeStatus === 'connected') return undefined;");
    expect(marketViewSource).toContain('REST_BOOTSTRAP_GRACE_MS');
    expect(marketViewSource).toContain('if (lostRealtime) void refreshDepth();');
    expect(marketViewSource).toContain('if (lostRealtime) void refreshTrades();');
  });

  test('keeps a pending ETH to BTC selection ahead of the stale URL', () => {
    let activeSymbol = 'ETHUSDT_PERP';
    let pendingNavigationSymbol: string | null = null;
    let symbolTransitionCount = 0;
    let widgetCreateCount = 0;

    const applySymbol = (nextSymbol: string) => {
      if (nextSymbol === activeSymbol) return;
      activeSymbol = nextSymbol;
      symbolTransitionCount += 1;
      widgetCreateCount += 1;
    };

    pendingNavigationSymbol = 'BTCUSDT_PERP';
    applySymbol(pendingNavigationSymbol);

    const staleUrlDecision = resolveContractSymbolUrlSyncOwnership({
      pendingNavigationSymbol,
      urlContractSymbol: 'ETHUSDT_PERP',
    });
    pendingNavigationSymbol = staleUrlDecision.pendingNavigationSymbol;
    if (staleUrlDecision.shouldApplyUrlSymbol) applySymbol('ETHUSDT_PERP');

    const settledUrlDecision = resolveContractSymbolUrlSyncOwnership({
      pendingNavigationSymbol,
      urlContractSymbol: 'BTCUSDT_PERP',
    });
    pendingNavigationSymbol = settledUrlDecision.pendingNavigationSymbol;
    if (settledUrlDecision.shouldApplyUrlSymbol) applySymbol('BTCUSDT_PERP');

    expect(activeSymbol).toBe('BTCUSDT_PERP');
    expect(symbolTransitionCount).toBe(1);
    expect(widgetCreateCount).toBe(1);
    expect(pendingNavigationSymbol).toBeNull();
    expect(pageSource).toContain('pendingNavigationSymbolRef.current = normalizedSymbol;');
    expect(pageSource).toContain('if (!urlSyncOwnership.shouldApplyUrlSymbol) return;');
  });
});
