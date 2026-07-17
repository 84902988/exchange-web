import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hookSource = readFileSync(
  resolve(process.cwd(), 'components/contract/hooks/useContractMarketView.ts'),
  'utf8',
);

describe('useContractMarketView Price Authority wiring', () => {
  it('builds and returns one reference authority including closed-market ticker evidence', () => {
    expect(hookSource).toMatch(/buildContractPriceAuthority/);
    expect(hookSource).toMatch(/selectContractReferencePrice/);
    expect(hookSource).toMatch(/const priceAuthority = useMemo/);
    expect(hookSource).toMatch(/const referencePrice = useMemo/);
    expect(hookSource).toMatch(/ticker:\s*\{/);
    expect(hookSource).toMatch(/price:\s*fallbackLastPrice/);
    expect(hookSource).toMatch(/source:\s*fallbackLastPriceSource/);
    expect(hookSource).toMatch(/freshness:\s*fallbackQuoteFreshness/);
    expect(hookSource).toMatch(/marketStatus:\s*fallbackMarketStatus/);
    expect(hookSource).toMatch(/priceAuthority,\s*\n\s*referencePrice,\s*\n\s*displayPrice,/);
    expect(hookSource).toMatch(/const displayPrice = marketViewAuthority\.displayPrice;/);
  });

  it('does not migrate Contract component consumers during Phase B-1', () => {
    expect(hookSource).not.toMatch(/ContractMarketHeader/);
    expect(hookSource).not.toMatch(/ContractFuturesOrderBook/);
    expect(hookSource).not.toMatch(/ContractTradingViewChart/);
    expect(hookSource).not.toMatch(/ContractTradingForm/);
  });
});
