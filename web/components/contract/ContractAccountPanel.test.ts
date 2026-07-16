import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('contract account hides unusable equity instead of formatting it as zero', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'components/contract/ContractAccountPanel.tsx'),
    'utf8',
  );

  expect(source).toContain('account?.equity_usable !== false');
  expect(source).toContain('const accountEquity = accountEquityUsable ? account?.equity : null;');
  expect(source).toContain("const hasValue = value !== undefined && value !== null && value !== '';");
  expect(source).toContain("{hasValue ? `${formatNumber(value, 4)} USDT` : '--'}");
});
