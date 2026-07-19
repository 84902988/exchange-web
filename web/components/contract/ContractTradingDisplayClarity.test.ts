import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

test('position metric overflow protection preserves liquidation risk evidence', () => {
  const source = readSource('components/contract/ContractPositionTabs.tsx');

  expect(source).toContain("label={t('liquidationPrice', 'contracts')}");
  expect(source).toContain("label={t('liquidationDistance', 'contracts')}");
  expect(source).toContain('<RiskBar risk={liquidationRisk} />');
  expect(source).toContain('truncate whitespace-nowrap font-mono');
  expect(source).toContain('title={value}');
});

test('spread cost is visibly marked as an estimate in form and confirmation', () => {
  const source = readSource('components/contract/ContractTradingForm.tsx');

  expect(source.match(/`≈ \$\{formatPrice\(/g)).toHaveLength(2);
});

test('English contract copy does not fall back to Chinese for estimated execution price', () => {
  const locale = JSON.parse(readSource('config/locales/en.json')) as {
    contracts?: { estimatedExecutionPrice?: string };
  };

  expect(locale.contracts?.estimatedExecutionPrice).toBe('Estimated execution price');
});
