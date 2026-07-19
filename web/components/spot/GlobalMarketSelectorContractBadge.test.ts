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
