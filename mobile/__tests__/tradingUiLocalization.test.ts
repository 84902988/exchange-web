import {
  tradingUiEn,
  tradingUiJa,
  tradingUiZhCN,
  tradingUiZhTW,
} from '../src/i18n/tradingUiCatalog';
import {createTranslator} from '../src/i18n';

describe('spot and contract trading UI localization', () => {
  it('keeps every trading UI key explicit in all four languages', () => {
    const expectedKeys = Object.keys(tradingUiZhCN).sort();

    expect(expectedKeys.length).toBeGreaterThan(250);
    expect(Object.keys(tradingUiZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(tradingUiEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(tradingUiJa).sort()).toEqual(expectedKeys);
  });

  it('translates order forms, records, validation and protection messages', () => {
    expect(createTranslator('zh-CN')('contract.openLong')).toBe('买单');
    expect(createTranslator('zh-CN')('contract.openShort')).toBe('卖单');
    expect(createTranslator('zh-CN')('contract.closeLong')).toBe('平多');
    expect(createTranslator('zh-CN')('contract.closeShort')).toBe('平空');
    expect(createTranslator('zh-TW')('contract.openLong')).toBe('買單');
    expect(createTranslator('zh-TW')('contract.openShort')).toBe('賣單');
    expect(createTranslator('en')('contract.openLong')).toBe('Buy');
    expect(createTranslator('en')('contract.openShort')).toBe('Sell');
    expect(createTranslator('ja')('contract.openLong')).toBe('買い');
    expect(createTranslator('ja')('contract.openShort')).toBe('売り');
    expect(createTranslator('zh-TW')('trading.tab.currentOrders')).toBe(
      '目前委託',
    );
    expect(createTranslator('en')('spot.quantityPrecision', {precision: 8})).toBe(
      'Amount supports up to 8 decimal places',
    );
    expect(
      createTranslator('ja')('contract.maxLeverage', {leverage: 50}),
    ).toBe('この契約の最大レバレッジは 50x です');
    expect(
      createTranslator('en')('contract.submittedResult', {
        action: 'Open',
        identity: ' #123',
        status: 'NEW',
      }),
    ).toBe('Open #123 submitted. Status: NEW');
    expect(
      createTranslator('ja')('contract.possibleOrder', {identity: ' #88'}),
    ).toContain('#88');
  });
});
