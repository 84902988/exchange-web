import { describe, expect, it } from '@jest/globals';
import {
  normalizeReferenceOverlayConfig,
  normalizeReferenceOverlaySymbol,
} from './referenceOverlay';

const translate = (key: string) => key;

describe('reference overlay symbol identity', () => {
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
