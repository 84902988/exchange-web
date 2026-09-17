import { describe, expect, it } from '@jest/globals';
import zh from '@/config/locales/zh.json';
import zhTW from '@/config/locales/zh-TW.json';
import en from '@/config/locales/en.json';
import ja from '@/config/locales/ja.json';
import {
  getReferenceOverlayConfig,
  normalizeReferenceOverlayConfig,
  normalizeReferenceOverlaySymbol,
} from './referenceOverlay';

const translate = (key: string) => key;
const translateZh = (key: string) => zh.asset[key as keyof typeof zh.asset] as string;

describe('reference overlay symbol identity', () => {
  it('does not restore a hard-coded MFC quote when the reference API is unavailable', () => {
    expect(getReferenceOverlayConfig('MFCUSDT', translate)).toBeNull();
  });

  it('treats display separators as aliases instead of distinct RWA symbols', () => {
    expect(normalizeReferenceOverlaySymbol('BON-2/USDT')).toBe('BON2USDT');
    expect(normalizeReferenceOverlaySymbol('bon2usdt')).toBe('BON2USDT');
    expect(normalizeReferenceOverlaySymbol('CREG-2USDT')).toBe('CREG2USDT');
  });

  it('normalizes provider payload symbols to the canonical reference identity', () => {
    const config = normalizeReferenceOverlayConfig({
      symbol: 'BON-2USDT',
      enabled: true,
      reference_type: 'STOCK',
      display_price: '1.16',
      display_unit: 'USD',
      line_color: '#f0b90b',
    }, translate);

    expect(config).toMatchObject({
      symbol: 'BON2USDT',
      kind: 'STOCK',
      displayPrice: 1.16,
    });
  });

  it.each([
    ['English', '{symbol} Stock Reference', 'BON Stock Reference'],
    ['Simplified Chinese', '{symbol} 股票参考价', 'BON 股票参考价'],
    ['Traditional Chinese', '{symbol} 股票參考價', 'BON 股票參考價'],
    ['Japanese', '{symbol} 株式参考価格', 'BON 株式参考価格'],
  ])('uses the active %s locale for card and chart-line titles', (_locale, template, expected) => {
    const translateTitle = (key: string) => (
      key === 'spotReferenceStockTitle' ? template : key
    );
    const config = normalizeReferenceOverlayConfig({
      symbol: 'BON2USDT',
      enabled: true,
      reference_type: 'STOCK',
      display_price: '1.16',
      display_unit: 'USD',
      title: 'BON股票参考价',
      line_title: 'BON股票参考价',
    }, translateTitle);

    expect(config).toMatchObject({
      title: expected,
      lineTitle: expected,
    });
  });

  it('keeps the active locale description instead of a legacy single-language database value', () => {
    const translateEnglish = (key: string) => (
      key === 'spotReferenceIronDescription'
        ? '1 MFC ≈ 1 KG iron powder'
        : key
    );
    const config = normalizeReferenceOverlayConfig({
      symbol: 'MFCUSDT',
      enabled: true,
      reference_type: 'IRON',
      display_price: '0.108',
      description: '1 MFC ≈ 1KG 铁粉',
    }, translateEnglish);

    expect(config?.description).toBe('1 MFC ≈ 1 KG iron powder');
  });
});

describe('manual iron reference price editing', () => {
  const manualIron = {
    symbol: 'MFCUSDT',
    enabled: true,
    reference_type: 'IRON',
    price_source: 'MANUAL',
    display_price: '0.09802',
    display_value_label: '0.108 USD/公斤',
    last_ref_price: '0.108',
    last_ref_label: '108 USD/吨',
  };

  it.each([undefined, null, '108 USD/吨'])(
    'uses the edited manual price despite a historical source label of %s',
    sourcePriceLabel => {
      const config = normalizeReferenceOverlayConfig({
        ...manualIron,
        source_price_label: sourcePriceLabel,
      }, translateZh);

      expect(config).toMatchObject({
        displayPrice: 0.09802,
        valueLabel: '0.09802 USD/公斤',
        sourcePriceLabel: '98.02 USD/吨',
      });
    },
  );

  it('updates both units again when the saved manual price changes', () => {
    const config = normalizeReferenceOverlayConfig({
      ...manualIron, display_price: '0.101',
    }, translateZh);
    expect(config).toMatchObject({
      displayPrice: 0.101,
      valueLabel: '0.101 USD/公斤',
      sourcePriceLabel: '101 USD/吨',
    });
  });

  it.each([
    ['zh', zh.asset, 'USD/公斤', 'USD/吨'],
    ['zh-TW', zhTW.asset, 'USD/公斤', 'USD/噸'],
    ['en', en.asset, 'USD/kg', 'USD/ton'],
    ['ja', ja.asset, 'USD/kg', 'USD/トン'],
  ] as const)('keeps the price pair consistent in %s', (_locale, catalog, kgUnit, tonUnit) => {
    const t = (key: string) => catalog[key as keyof typeof catalog] as string;
    const config = normalizeReferenceOverlayConfig(manualIron, t);
    expect(config?.valueLabel).toBe(`0.09802 ${kgUnit}`);
    expect(config?.sourcePriceLabel).toBe(`98.02 ${tonUnit}`);
  });

  it('still uses the synchronized price in AUTO mode', () => {
    const config = normalizeReferenceOverlayConfig({
      ...manualIron,
      price_source: 'AUTO',
      display_price: '0.09509',
      source_price_label: '95.09 USD/吨',
    }, translateZh);
    expect(config).toMatchObject({
      displayPrice: 0.09509,
      valueLabel: '0.09509 USD/公斤',
      sourcePriceLabel: '95.09 USD/吨',
    });
  });

  it('does not revive historical prices when the API explicitly clears the source label', () => {
    const config = normalizeReferenceOverlayConfig({
      ...manualIron, price_source: 'AUTO', source_price_label: null,
    }, translateZh);
    expect(config?.sourcePriceLabel).toBeNull();
  });

  it('does not show a historic AUTO quote for a manual price of another asset type', () => {
    const config = normalizeReferenceOverlayConfig({
      ...manualIron,
      reference_type: 'STOCK',
      symbol: 'BON2USDT',
      display_price: '1.25',
      display_value_label: '1.25 USD',
      last_ref_label: '2 USD',
      source_price_label: null,
    }, translateZh);
    expect(config?.sourcePriceLabel).toBeNull();
    expect(config?.valueLabel).toBe('1.25 USD');
  });
});
