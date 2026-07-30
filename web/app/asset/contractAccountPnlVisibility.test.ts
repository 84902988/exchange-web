import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('asset overview does not expose cumulative contract account PnL', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'app/asset/page.tsx'),
    'utf8',
  );

  expect(source).not.toContain("t('realizedPnl', 'asset')");
  expect(source).not.toContain('contractAccount.realized_pnl');
});
