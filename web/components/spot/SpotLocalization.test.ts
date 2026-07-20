import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const localeNames = ['en', 'zh', 'zh-TW', 'ja'] as const;

function readLocale(name: (typeof localeNames)[number]) {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'config', 'locales', `${name}.json`), 'utf8'),
  ) as { asset?: Record<string, string> };
}

describe('Spot localization coverage', () => {
  it('routes the latest-trade label through the asset language pack', () => {
    const source = readFileSync(
      join(process.cwd(), 'components', 'spot', 'SpotTradingForm.tsx'),
      'utf8',
    );

    expect(source).toContain("latestTrade: t('spotFormLatestTrade', 'asset')");
    expect(source).toContain('{copy.latestTrade}');
    expect(source).not.toContain('LATEST_TRADE_LABEL');
  });

  it('keeps the Spot form and reference keys aligned across every locale', () => {
    const locales = Object.fromEntries(localeNames.map((name) => [name, readLocale(name)]));
    const relevantKeys = Object.keys(locales.en.asset || {})
      .filter((key) => key.startsWith('spotForm') || key.startsWith('spotReference'))
      .sort();

    expect(relevantKeys.length).toBeGreaterThan(0);
    for (const name of localeNames) {
      const keys = Object.keys(locales[name].asset || {})
        .filter((key) => key.startsWith('spotForm') || key.startsWith('spotReference'))
        .sort();
      expect(keys).toEqual(relevantKeys);
    }

    expect(locales.en.asset?.spotFormLatestTrade).toBe('Last trade');
    expect(locales.zh.asset?.spotFormLatestTrade).toBe('最新成交');
    expect(locales['zh-TW'].asset?.spotFormLatestTrade).toBe('最新成交');
    expect(locales.ja.asset?.spotFormLatestTrade).toBe('最新約定');
  });

  it('does not leave Chinese UI copy in the English trading namespaces', () => {
    const english = readLocale('en') as {
      asset?: Record<string, string>;
      contracts?: Record<string, string>;
    };

    expect(JSON.stringify({
      asset: english.asset,
      contracts: english.contracts,
    })).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
