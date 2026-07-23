import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('spot market tabs remain readable in the narrow side panel', () => {
  const source = readFileSync(resolve(process.cwd(), 'components/spot/SpotPage.tsx'), 'utf8');
  const panelStart = source.indexOf("rightPanelTab === 'orderbook'");
  const panelSource = source.slice(Math.max(0, panelStart - 500), panelStart + 1_200);

  expect(panelStart).toBeGreaterThanOrEqual(0);
  expect(panelSource).toContain('flex h-10 min-w-0 items-stretch gap-3');
  expect(panelSource.match(/shrink-0 whitespace-nowrap/g)).toHaveLength(2);
  expect(panelSource).not.toContain('inline-flex h-10 items-stretch gap-5');
});

test('spot pair membership is refreshed from the control plane without a page cache', () => {
  const source = readFileSync(resolve(process.cwd(), 'components/spot/SpotPage.tsx'), 'utf8');

  expect(source).not.toContain('cachedSpotPairPages');
  expect(source).not.toContain('SPOT_PAIR_PAGE_CACHE_TTL_MS');
  expect(source).toContain('onCatalogRefresh={refreshSpotPairCatalog}');
  expect(source).toContain('isSpotPairUnavailableError(spotMarket.error)');
  expect(source).toContain('router.replace(`/trade/spot?symbol=');
});
