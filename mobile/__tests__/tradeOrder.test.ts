import {
  formatOrderDecimal,
  getTradingErrorMessage,
  parsePositiveDecimal,
} from '../src/utils/tradeOrder';
import {ApiClientError} from '../src/api/client';

describe('trade order helpers', () => {
  it('normalizes positive decimal input before it enters an API payload', () => {
    expect(parsePositiveDecimal('01,234.5600')).toEqual({
      text: '1234.56',
      value: 1234.56,
      decimalPlaces: 2,
    });
  });

  it('rejects zero, negative and malformed decimal input', () => {
    expect(parsePositiveDecimal('0')).toBeNull();
    expect(parsePositiveDecimal('-1')).toBeNull();
    expect(parsePositiveDecimal('1.2.3')).toBeNull();
  });

  it('formats computed order values without trailing zeroes', () => {
    expect(formatOrderDecimal(12.5, 8)).toBe('12.5');
    expect(formatOrderDecimal(0.000001, 8)).toBe('0.000001');
  });

  it('maps backend trading errors to actionable Chinese messages', () => {
    expect(
      getTradingErrorMessage(
        new ApiClientError(
          'INSUFFICIENT_CONTRACT_MARGIN',
          'INSUFFICIENT_CONTRACT_MARGIN',
          400,
        ),
        '提交失败',
      ),
    ).toBe('可用保证金不足');

    expect(
      getTradingErrorMessage(
        new ApiClientError(
          'OPEN_WOULD_LIQUIDATE_IMMEDIATELY',
          '当前成交价与杠杆会使仓位开仓后立即达到强平条件',
          400,
        ),
        '提交失败',
      ),
    ).toBe('当前杠杆和成交价会导致开仓后立即强平，请降低杠杆后重试');
  });
});
