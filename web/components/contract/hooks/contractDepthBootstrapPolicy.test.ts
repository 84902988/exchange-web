import { describe, expect, test } from '@jest/globals';
import { resolveContractDepthBootstrapPresentation } from './contractDepthBootstrapPolicy';

describe('Contract depth bootstrap presentation', () => {
  test.each([
    ['FULL_DEPTH', 'crypto full depth'],
    ['BBO_ONLY', 'stock and CFD one-level BBO'],
  ])('%s is immediately usable for %s', (depthMode) => {
    expect(resolveContractDepthBootstrapPresentation(depthMode, true, false)).toEqual({
      exposeRows: true,
      delayRows: false,
      depthMode,
    });
  });

  test('synthetic fallback waits for grace, then becomes displayable', () => {
    expect(resolveContractDepthBootstrapPresentation('SYNTHETIC_FROM_BBO', true, false)).toEqual({
      exposeRows: false,
      delayRows: true,
      depthMode: null,
    });
    expect(resolveContractDepthBootstrapPresentation('SYNTHETIC_FROM_BBO', true, true)).toEqual({
      exposeRows: true,
      delayRows: false,
      depthMode: 'SYNTHETIC_FROM_BBO',
    });
  });

  test('metadata without rows never pretends that depth is ready', () => {
    expect(resolveContractDepthBootstrapPresentation('FULL_DEPTH', false, true)).toEqual({
      exposeRows: false,
      delayRows: false,
      depthMode: null,
    });
  });
});
