import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveContractSymbolUrlSyncOwnership } from './contractSymbolNavigation';

const pageSource = readFileSync(
  resolve(process.cwd(), 'app/contract/page.tsx'),
  'utf8',
);

describe('Contract TradingView bootstrap experience', () => {
  test('waits for symbol metadata before creating the only chart widget consumer', () => {
    expect(pageSource).toContain("currentContractKlineAssetClass !== 'UNKNOWN'");
    expect(pageSource).toContain('&& chartBootstrapMatchesUrlCategory;');
    expect(pageSource).not.toContain(
      'const chartBootstrapReady = contractPairsLoaded && currentContractPair !== null;',
    );
    expect(pageSource).toMatch(
      /\{chartBootstrapReady \? \([\s\S]*?<ContractTradingViewChart[\s\S]*?: \([\s\S]*?data-contract-chart-bootstrap="pending"/,
    );
    expect(pageSource.match(/<ContractTradingViewChart/g)).toHaveLength(1);
  });

  test('loads current symbol metadata before the full selector catalog', () => {
    const bootstrapRequestIndex = pageSource.indexOf('keyword: bootstrapSymbol');
    const catalogRequestIndex = pageSource.indexOf("getContractSymbols({ category: 'all'");

    expect(bootstrapRequestIndex).toBeGreaterThan(-1);
    expect(catalogRequestIndex).toBeGreaterThan(bootstrapRequestIndex);
    expect(pageSource).toContain('page_size: 1');
    expect(pageSource).toContain('The full catalog remains the fail-closed metadata fallback.');
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
