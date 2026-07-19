import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), 'components/contract/hooks/useContractUserState.ts'),
  'utf8',
);

test('position mark events merge rows and patch position caches', () => {
  expect(source).toContain('export function mergeContractPositionMarkRows(');
  expect(source).toContain('return update ? { ...item, ...update } : item;');
  expect(source).toContain('positionScopeCacheRef.current.forEach((entry, key) => {');
  expect(source).toContain('positionsPageCacheRef.current.forEach((entry, key) => {');
});

test('mark-only position events never trigger a REST fanout', () => {
  expect(source).toContain("=== 'contract_user_position_mark_update'");
  expect(source).toContain('if (isContractPositionMarkOnlyMessage(message)) return false;');
  expect(source).toContain('markOnly ? false : positionsUpdate.replace');
  expect(source).toContain('markOnly ? false : summariesUpdate.replace');
  expect(source).toContain('!isContractPositionMarkOnlyMessage(message)');
  expect(source).toContain('if (invalidateRestBaseline) invalidatePrivateRestBaseline();');
  expect(source).toContain('privateRefreshCoordinatorRef.current.replayActive();');
});

test('private REST refreshes are single-flight per visible scope with one trailing replay', () => {
  expect(source).toContain('const privateRefreshCoordinatorRef = useRef(new ContractPrivateRefreshCoordinator());');
  expect(source).toContain("request(privateRefreshKey) === 'COALESCED'");
  expect(source).toContain('const shouldReplay = privateRefreshCoordinatorRef.current.settle(privateRefreshKey);');
  expect(source).toContain('void refreshPrivateReplayRef.current({ silent: true });');
  expect(source).toContain('privateRefreshCoordinatorRef.current.reset();');
});

test('position events preserve symbol and sequence fences', () => {
  expect(source).toContain("return messageSymbols.length === 0 || messageSymbols.includes(normalizedCurrentSymbol);");
  expect(source).toContain('if (!acceptsContractRealtimeSequence(lastRealtimeSeqRef.current, message)) return false;');
  expect(source).toContain('return seq === null || seq >= lastSeq;');
  expect(source).toContain("extractContractPositionsUpdate(message, contractSymbol, dataScope === 'all')");
});

test('structural position events retain the existing REST fallback', () => {
  expect(source).toContain("return activeTab === 'positions' && (hasPositionUpdate || dataScope === 'all');");
  expect(source).toContain('void refreshPrivate({ silent: true });');
});
