import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), 'components/contract/ContractPositionTabs.tsx'),
  'utf8',
);

test('position risk presentation fails closed for stale and unavailable marks', () => {
  expect(source).toContain("return state === 'STALE' ? '-- (STALE)' : '-- (UNAVAILABLE)';");
  expect(source).toContain("if (record?.mark_usable === false) return false;");
  expect(source).toContain("if (markFreshness === 'STALE' || markFreshness === 'UNAVAILABLE') return false;");
  expect(source).toContain('const truthUnavailableLabel = getPositionTruthUnavailableLabel(item);');
});

test('UPNL margin and liquidation risk use the same position snapshot state', () => {
  expect(source).toContain('const marginRatio = truthUnavailableLabel ?? formatPlainPercent(item.margin_ratio);');
  expect(source).toContain('const liquidationDistance = truthUnavailableLabel ?? formatLiquidationDistance(item.liquidation_distance, pricePrecision);');
  expect(source).toContain('if (!isPositionMarkSnapshotUsable(record)) return null;');
  expect(source).toContain("unrealized === null ? (truthUnavailableLabel ?? '--')");
});

test('legacy position records without truth metadata remain renderable', () => {
  const truthHelper = source.slice(
    source.indexOf('export function isPositionMarkSnapshotUsable'),
    source.indexOf('export function getPositionTruthUnavailableLabel'),
  );

  expect(truthHelper).toContain("const markFreshness = String(record?.mark_freshness || '')");
  expect(truthHelper).toContain("const pnlState = String(record?.unrealized_pnl_state || '')");
  expect(truthHelper).toContain('return true;');
});
