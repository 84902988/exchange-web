import { shouldUseCompactAssetLayout } from '../src/components/assets/assetLayout';

describe('asset responsive layout', () => {
  it('stacks dense cards on small screens or enlarged text', () => {
    expect(shouldUseCompactAssetLayout(359, 1)).toBe(true);
    expect(shouldUseCompactAssetLayout(390, 1.3)).toBe(true);
    expect(shouldUseCompactAssetLayout(390, 1)).toBe(false);
  });
});
