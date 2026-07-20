import { describe, expect, it } from '@jest/globals';
import { resolveSpotFeePreferenceDisplay } from './spotFeePreferenceDisplay';

const copy = {
  rcbPaymentLabel: 'RCB 抵扣',
  usdtFeeTitle: '当前使用 USDT 支付手续费',
  rcbDisabledSubtitle: '平台未启用 RCB 手续费抵扣',
  rcbEnableSubtitle: '启用 RCB 抵扣后，将按 75% 计算手续费',
  rcbEnabledTitle: '已启用 RCB 抵扣，手续费按 75% 预估。',
};

describe('Spot fee preference display', () => {
  it('keeps an enabled RCB preference visible before a fee amount can be estimated', () => {
    expect(resolveSpotFeePreferenceDisplay({
      ...copy,
      spotRcbFeeEnabled: true,
      useRcbFee: true,
    })).toEqual({
      payment: 'RCB 抵扣',
      hintTitle: '已启用 RCB 抵扣，手续费按 75% 预估。',
      hintSubtitle: '',
      hintTone: 'success',
      showOpenLink: false,
    });
  });

  it('shows USDT when the user preference is disabled', () => {
    expect(resolveSpotFeePreferenceDisplay({
      ...copy,
      spotRcbFeeEnabled: true,
      useRcbFee: false,
    })).toEqual({
      payment: 'USDT',
      hintTitle: '当前使用 USDT 支付手续费',
      hintSubtitle: '启用 RCB 抵扣后，将按 75% 计算手续费',
      hintTone: 'neutral',
      showOpenLink: true,
    });
  });

  it('shows the platform-disabled state without offering the preference link', () => {
    expect(resolveSpotFeePreferenceDisplay({
      ...copy,
      spotRcbFeeEnabled: false,
      useRcbFee: true,
    })).toEqual({
      payment: 'USDT',
      hintTitle: '当前使用 USDT 支付手续费',
      hintSubtitle: '平台未启用 RCB 手续费抵扣',
      hintTone: 'neutral',
      showOpenLink: false,
    });
  });
});
