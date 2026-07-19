import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const loadingSource = readFileSync(resolve(process.cwd(), 'app/contract/loading.tsx'), 'utf8');

describe('Contract route loading boundary', () => {
  test('provides an immediate lightweight fallback without owning chart state', () => {
    expect(loadingSource).toContain('role="status"');
    expect(loadingSource).toContain('Loading futures market');
    expect(loadingSource).not.toContain('ContractTradingViewChart');
    expect(loadingSource).not.toContain('createContractTradingViewDatafeed');
  });
});
