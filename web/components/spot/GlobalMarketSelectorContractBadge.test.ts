import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('contract header selector renders a localized perpetual badge before the dropdown arrow', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/spot/GlobalMarketSelector.tsx'),
    'utf8',
  );
  const labelIndex = source.indexOf('>{currentLabel}</span>');
  const badgeIndex = source.indexOf('data-testid="market-selector-contract-badge"');
  const dropdownArrowIndex = source.indexOf('aria-hidden="true"', badgeIndex);
  const badgeBlock = source.slice(
    source.lastIndexOf('<span', badgeIndex),
    source.indexOf('</span>', badgeIndex),
  );

  expect(source).toContain("pageType === 'contract' && isHeaderPlacement");
  expect(source).toContain("{t('perpetualSuffix', 'markets')}");
  expect(labelIndex).toBeGreaterThanOrEqual(0);
  expect(badgeIndex).toBeGreaterThan(labelIndex);
  expect(dropdownArrowIndex).toBeGreaterThan(badgeIndex);
  expect(badgeBlock).toContain('rounded-full bg-white/[0.12]');
  expect(badgeBlock).not.toContain('#f0b90b');
  expect(badgeBlock).not.toContain('border');
});

test('parent-provided contract pairs own selector membership over stale module cache', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/spot/GlobalMarketSelector.tsx'),
    'utf8',
  );

  expect(source).toContain("const contractSource = pairs !== undefined && pageType === 'contract'");
  expect(source).toContain('? externalContractPairs');
  expect(source).toContain('current control-plane catalog');
  expect(source).toContain('administrator has just disabled');
});

test('parent-provided spot pairs and favorites cannot be resurrected from stale caches', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/spot/GlobalMarketSelector.tsx'),
    'utf8',
  );

  expect(source).toContain("const spotSource = pairs !== undefined && pageType === 'spot'");
  expect(source).toContain('const parentOwnsFavoriteMarket');
  expect(source).toContain('onCatalogRefresh');
  expect(source).toContain('const catalogMembershipRefreshing');
  expect(source).toContain('spotPairsCacheFetchedAtRef.current.clear()');
  expect(source).toContain('contractPairsCacheFetchedAtRef.current.clear()');
});
