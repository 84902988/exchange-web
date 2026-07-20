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

test('UPNL falls back to the private snapshot while margin risk stays snapshot-authoritative', () => {
  expect(source).toContain('const marginRatio = truthUnavailableLabel ?? formatPlainPercent(item.margin_ratio);');
  expect(source).toContain('if (!isPositionMarkSnapshotUsable(record)) return null;');
  expect(source).toContain('const displayTruthUnavailableLabel = liveValuation ? null : truthUnavailableLabel;');
  expect(source).toContain("unrealized === null ? (displayTruthUnavailableLabel ?? '--')");
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

test('TradFi TP/SL dialog displays and validates against the same live BBO reference', () => {
  const dialogStart = source.indexOf('{tpSlDraft ? (');
  const dialogEnd = source.indexOf('error={tpSlError}', dialogStart);
  const dialogSource = source.slice(dialogStart, dialogEnd);

  expect(dialogSource).toContain('liveBestBid,');
  expect(dialogSource).toContain('liveBestAsk,');
  expect(dialogSource).toContain('liveMarketUsable,');
  expect(dialogSource).toContain('preferLiveBbo: tradfiSymbolSet.has');
  expect(source).toContain('adjustTpSlEditorPrice(current[field], draft.referencePrice, delta)');
});
