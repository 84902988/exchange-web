import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

test('contract catalog carries the canonical base-asset logo into the shared selector', () => {
  const apiSource = readSource('lib/api/modules/contract.ts');
  const pageSource = readSource('app/contract/page.tsx');
  const selectorSource = readSource('components/spot/GlobalMarketSelector.tsx');

  expect(apiSource).toContain('base_asset_logo_url?: string | null');
  expect(pageSource).toContain("baseAssetLogoUrl: String(item.base_asset_logo_url || '').trim() || null");
  expect(selectorSource).toContain('resolveSpotAssetImageUrl(pair?.baseAssetLogoUrl)');
  expect(selectorSource).toContain('onError={() => markLogoFailed(rowActiveLogoUrl)}');
});
