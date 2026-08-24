import {
  marketEn,
  marketJa,
  marketZhCN,
  marketZhTW,
} from '../src/i18n/marketCatalog';
import { createTranslator } from '../src/i18n';

describe('market read-only UI localization', () => {
  it('keeps the complete market catalog explicit and aligned in all four languages', () => {
    const expectedKeys = Object.keys(marketZhCN).sort();

    expect(expectedKeys).toHaveLength(108);
    expect(Object.keys(marketZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(marketEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(marketJa).sort()).toEqual(expectedKeys);
  });

  it('translates market, detail, candle and indicator UI with interpolation', () => {
    expect(createTranslator('zh-CN')('markets.category.crypto')).toBe(
      '加密货币',
    );
    expect(createTranslator('zh-TW')('marketDetail.tab.depth')).toBe('盤口');
    expect(
      createTranslator('en')('marketDetail.quantity', { asset: 'BTC' }),
    ).toBe('Amount (BTC)');
    expect(createTranslator('ja')('kline.failed')).toBe(
      'ローソク足の読み込みに失敗しました',
    );
    expect(createTranslator('en')('indicatorSettings.apply')).toBe('Apply');
    expect(
      createTranslator('ja')('markets.tradeUnsupportedMessage', {
        symbol: 'BTC/USDT',
      }),
    ).toContain('BTC/USDT');
  });
});
