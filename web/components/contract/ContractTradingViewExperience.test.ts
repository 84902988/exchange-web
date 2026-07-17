import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pageSource = readFileSync(
  resolve(process.cwd(), 'app/contract/page.tsx'),
  'utf8',
);

describe('Contract TradingView bootstrap experience', () => {
  test('waits for symbol metadata before creating the only chart widget consumer', () => {
    expect(pageSource).toContain(
      'const chartBootstrapReady = contractPairsLoaded && currentContractPair !== null;',
    );
    expect(pageSource).toMatch(
      /\{chartBootstrapReady \? \([\s\S]*?<ContractTradingViewChart[\s\S]*?: \([\s\S]*?data-contract-chart-bootstrap="pending"/,
    );
    expect(pageSource.match(/<ContractTradingViewChart/g)).toHaveLength(1);
  });
});
