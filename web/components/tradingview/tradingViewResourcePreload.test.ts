import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('TradingView route resource preload', () => {
  test.each([
    'app/trade/layout.tsx',
    'app/contract/layout.tsx',
    'app/mobile/advanced-chart/layout.tsx',
  ])(
    '%s starts the chart library request during route render',
    (path) => {
      const source = readSource(path);
      expect(source).toContain('<link rel="preload"');
      expect(source).toContain('charting_library.js');
      expect(source).toContain('as="script"');
    },
  );

  test('TradingView hashed bundles are immutable while the unhashed entry revalidates', () => {
    const source = readSource('next.config.ts');
    expect(source).toContain('/tradingview/charting_library/:path*');
    expect(source).toContain('max-age=31536000, immutable');
    expect(source).toContain('/tradingview/charting_library/charting_library.js');
    expect(source).toContain('max-age=0, must-revalidate');
    expect(source.indexOf('max-age=31536000, immutable')).toBeLessThan(
      source.indexOf('max-age=0, must-revalidate'),
    );
  });
});
