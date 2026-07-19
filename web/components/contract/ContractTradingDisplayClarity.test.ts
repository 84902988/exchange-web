import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

test('active position cards omit liquidation metrics while preserving compact value overflow handling', () => {
  const source = readSource('components/contract/ContractPositionTabs.tsx');
  const summaryCards = source.slice(
    source.indexOf('function SummaryPositionsCards'),
    source.indexOf('function PositionsTable'),
  );
  const detailCard = source.slice(
    source.indexOf('function PositionDetailCard'),
    source.indexOf('function ClosePositionDialog'),
  );
  const allPositionsTable = source.slice(
    source.indexOf('function AllPositionsTable'),
    source.indexOf('function HistoryPositionsTable'),
  );

  expect(summaryCards).not.toContain("label={t('liquidationPrice', 'contracts')}");
  expect(summaryCards).not.toContain("label={t('liquidationDistance', 'contracts')}");
  expect(summaryCards).not.toContain('<RiskBar');
  expect(detailCard).not.toContain("label={t('liquidationPrice', 'contracts')}");
  expect(detailCard).not.toContain("label={t('liquidationDistance', 'contracts')}");
  expect(allPositionsTable).not.toContain("t('liquidationPrice', 'contracts')");
  expect(allPositionsTable).not.toContain("t('liquidationDistance', 'contracts')");
  expect(allPositionsTable).not.toContain("t('risk', 'contracts')");
  expect(allPositionsTable).not.toContain('getAuthoritativeLiquidationPrice');
  expect(allPositionsTable).not.toContain('getLiquidationRisk');
  expect(source).not.toContain('function RiskBar');
  expect(source).not.toContain("t('highRisk', 'contracts')");
  expect(source).toContain('truncate whitespace-nowrap font-mono');
  expect(source).toContain('title={value}');
});

test('spread cost is visibly marked as an estimate in form and confirmation', () => {
  const source = readSource('components/contract/ContractTradingForm.tsx');

  expect(source.match(/`≈ \$\{formatPrice\(/g)).toHaveLength(2);
  expect(source).not.toContain("label={t('estimatedLiquidationPrice', 'contracts')}");
  expect(source).not.toContain("label={t('liquidationPriceShort', 'contracts')}");
  expect(source).not.toContain("label={t('riskNotice', 'contracts')}");
});

test('English contract copy does not fall back to Chinese for estimated execution price', () => {
  const locale = JSON.parse(readSource('config/locales/en.json')) as {
    contracts?: {
      estimatedExecutionPrice?: string;
      spreadFloating?: string;
      buyOrder?: string;
      sellOrder?: string;
      confirmBuy?: string;
      confirmSell?: string;
      closePositionAction?: string;
    };
  };

  expect(locale.contracts?.estimatedExecutionPrice).toBe('Estimated execution price');
  expect(locale.contracts?.spreadFloating).toBe('Fluctuate');
  expect(locale.contracts?.buyOrder).toBe('Buy');
  expect(locale.contracts?.sellOrder).toBe('Sell');
  expect(locale.contracts?.confirmBuy).toBe('Confirm Buy');
  expect(locale.contracts?.confirmSell).toBe('Confirm Sell');
  expect(locale.contracts?.closePositionAction).toBe('Close Position');
});
