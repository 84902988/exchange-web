export type SpotFeeHintTone = 'neutral' | 'success' | 'warning';

export type SpotFeePreferenceDisplay = {
  payment: string;
  hintTitle: string;
  hintSubtitle: string;
  hintTone: SpotFeeHintTone;
  showOpenLink: boolean;
};

type ResolveSpotFeePreferenceDisplayInput = {
  spotRcbFeeEnabled: boolean;
  useRcbFee: boolean;
  rcbPaymentLabel: string;
  usdtFeeTitle: string;
  rcbDisabledSubtitle: string;
  rcbEnableSubtitle: string;
  rcbEnabledTitle: string;
};

export function resolveSpotFeePreferenceDisplay({
  spotRcbFeeEnabled,
  useRcbFee,
  rcbPaymentLabel,
  usdtFeeTitle,
  rcbDisabledSubtitle,
  rcbEnableSubtitle,
  rcbEnabledTitle,
}: ResolveSpotFeePreferenceDisplayInput): SpotFeePreferenceDisplay {
  if (!spotRcbFeeEnabled) {
    return {
      payment: 'USDT',
      hintTitle: usdtFeeTitle,
      hintSubtitle: rcbDisabledSubtitle,
      hintTone: 'neutral',
      showOpenLink: false,
    };
  }

  if (!useRcbFee) {
    return {
      payment: 'USDT',
      hintTitle: usdtFeeTitle,
      hintSubtitle: rcbEnableSubtitle,
      hintTone: 'neutral',
      showOpenLink: true,
    };
  }

  return {
    payment: rcbPaymentLabel,
    hintTitle: rcbEnabledTitle,
    hintSubtitle: '',
    hintTone: 'success',
    showOpenLink: false,
  };
}
