import {
  appendTradingNumericCharacter,
  removeTradingNumericCharacter,
} from '../src/components/common/TradingNumericInput';

describe('trading numeric input', () => {
  it('builds a positive decimal value without duplicate separators', () => {
    expect(appendTradingNumericCharacter('', '.')).toBe('0.');
    expect(appendTradingNumericCharacter('0', '4')).toBe('4');
    expect(appendTradingNumericCharacter('4562', '.')).toBe('4562.');
    expect(appendTradingNumericCharacter('4562.', '6')).toBe('4562.6');
    expect(appendTradingNumericCharacter('4562.6', '.')).toBe('4562.6');
  });

  it('ignores non-numeric keys and removes one character at a time', () => {
    expect(appendTradingNumericCharacter('12', '-')).toBe('12');
    expect(removeTradingNumericCharacter('12.3')).toBe('12.');
    expect(removeTradingNumericCharacter('')).toBe('');
  });
});
