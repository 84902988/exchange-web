import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const headerSource = readFileSync(resolve(process.cwd(), 'components/layout/Header.tsx'), 'utf8');

describe('header route prefetch', () => {
  test('prewarms primary trading routes and every visible mega-menu target', () => {
    expect(headerSource).toContain("router.prefetch('/trade/spot')");
    expect(headerSource).toContain("router.prefetch('/contract?category=usdt')");
    expect(headerSource).toContain('router.prefetch(menuItem.href)');
  });
});
