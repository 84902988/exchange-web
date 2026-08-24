import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import AdvancedChartIndicatorSettingsSheet from '../src/components/chart/AdvancedChartIndicatorSettingsSheet';
import {
  cloneAdvancedChartPreferences,
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  type AdvancedChartPreferencesV2,
} from '../src/components/chart/advancedChartConfig';
import { ADVANCED_CHART_INDICATORS } from '../src/components/chart/advancedChartIndicators';
import { colors } from '../src/theme';

const preferences: AdvancedChartPreferencesV2 = {
  ...cloneAdvancedChartPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES),
  selection: { overlay: 'BOLL', pane: 'MACD' },
};

function preferencesForSelection(
  selection: AdvancedChartPreferencesV2['selection'],
): AdvancedChartPreferencesV2 {
  return {
    ...cloneAdvancedChartPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES),
    selection,
  };
}

function findInput(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root
    .findAllByProps({ testID })
    .find(node => typeof node.props.onChangeText === 'function')!;
}

function resolvedChipStyle(
  renderer: ReactTestRenderer.ReactTestRenderer,
  kind: string,
) {
  const chip = renderer.root.findByProps({
    testID: `indicator-settings-chip-${kind.toLowerCase()}`,
  });
  return StyleSheet.flatten(chip.props.style({ pressed: false }));
}

describe('AdvancedChartIndicatorSettingsSheet', () => {
  it('shows all 13 indicator profiles and applies edits without losing other profiles', () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedChartIndicatorSettingsSheet
          preferences={preferences}
          visible
          onApply={onApply}
          onClose={onClose}
        />,
      );
    });

    ADVANCED_CHART_INDICATORS.forEach(kind => {
      expect(
        renderer.root.findByProps({
          testID: `indicator-settings-chip-${kind.toLowerCase()}`,
        }),
      ).toBeTruthy();
    });
    expect(
      renderer.root.findByProps({ testID: 'indicator-settings-chip-boll' })
        .props.accessibilityState.selected,
    ).toBe(true);

    act(() => {
      findInput(renderer, 'indicator-settings-length').props.onChangeText('0');
    });
    expect(
      renderer.root.findByProps({ testID: 'indicator-settings-apply' }).props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      renderer.root.findByProps({ testID: 'indicator-settings-error' }),
    ).toBeTruthy();

    act(() => {
      renderer.root
        .findByProps({ testID: 'indicator-settings-reset' })
        .props.onPress();
      renderer.root
        .findByProps({ testID: 'indicator-settings-chip-macd' })
        .props.onPress();
    });
    act(() => {
      findInput(renderer, 'indicator-settings-fast').props.onChangeText('10');
    });
    act(() => {
      renderer.root
        .findByProps({ testID: 'indicator-settings-apply' })
        .props.onPress();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      ...preferences,
      profiles: {
        ...preferences.profiles,
        MACD: { fastLength: 10, slowLength: 26, signalLength: 9 },
      },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('supports cancel without applying', () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedChartIndicatorSettingsSheet
          preferences={preferences}
          visible
          onApply={onApply}
          onClose={onClose}
        />,
      );
    });
    act(() => {
      renderer.root
        .findByProps({ testID: 'indicator-settings-cancel' })
        .props.onPress();
    });
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('disables the fixed-duration native Modal transition', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedChartIndicatorSettingsSheet
          preferences={preferences}
          visible
          onApply={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });
    expect(renderer.root.findByType(Modal).props.animationType).toBe('none');
    act(() => renderer.unmount());
  });

  it('uses a background only for the indicator currently being edited', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedChartIndicatorSettingsSheet
          preferences={preferences}
          visible
          onApply={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });

    expect(resolvedChipStyle(renderer, 'BOLL').backgroundColor).toBe(
      colors.goldSoft,
    );
    expect(resolvedChipStyle(renderer, 'MACD').borderColor).toBe(colors.gold);
    expect(resolvedChipStyle(renderer, 'MACD').backgroundColor).toBeUndefined();

    act(() => {
      renderer.root
        .findByProps({ testID: 'indicator-settings-chip-macd' })
        .props.onPress();
    });
    expect(resolvedChipStyle(renderer, 'BOLL').borderColor).toBe(colors.gold);
    expect(resolvedChipStyle(renderer, 'BOLL').backgroundColor).toBeUndefined();
    expect(resolvedChipStyle(renderer, 'MACD').backgroundColor).toBe(
      colors.goldSoft,
    );
    act(() => renderer.unmount());
  });

  it.each([
    {
      selection: { overlay: 'SAR' as const, pane: 'KDJ' as const },
      overlayField: 'indicator-settings-sar-start',
      paneField: 'indicator-settings-kdj-length',
    },
    {
      selection: { overlay: 'AVL' as const, pane: 'OBV' as const },
      overlayField: 'indicator-settings-avl-length',
      paneField: 'indicator-settings-obv-ma-length',
    },
    {
      selection: { overlay: 'SUPER' as const, pane: 'WR' as const },
      overlayField: 'indicator-settings-super-length',
      paneField: 'indicator-settings-wr-length',
    },
    {
      selection: { overlay: 'MA' as const, pane: 'StochRSI' as const },
      overlayField: 'indicator-settings-length',
      paneField: 'indicator-settings-stoch-rsi-length',
    },
  ])('shows editable fields for every expanded indicator %#', entry => {
    const selectedPreferences = preferencesForSelection(entry.selection);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedChartIndicatorSettingsSheet
          preferences={selectedPreferences}
          visible
          onApply={jest.fn()}
          onClose={jest.fn()}
        />,
      );
    });
    expect(findInput(renderer, entry.overlayField)).toBeTruthy();
    act(() => {
      renderer.root
        .findByProps({
          testID: `indicator-settings-chip-${entry.selection.pane.toLowerCase()}`,
        })
        .props.onPress();
    });
    expect(findInput(renderer, entry.paneField)).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('applies SAR decimals and complete StochRSI parameters', () => {
    const selectedPreferences = preferencesForSelection({
      overlay: 'SAR',
      pane: 'StochRSI',
    });
    const onApply = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AdvancedChartIndicatorSettingsSheet
          preferences={selectedPreferences}
          visible
          onApply={onApply}
          onClose={jest.fn()}
        />,
      );
    });
    act(() => {
      renderer.root
        .findByProps({ testID: 'indicator-settings-sar-start-minus' })
        .props.onPress();
      renderer.root
        .findByProps({ testID: 'indicator-settings-chip-stochrsi' })
        .props.onPress();
    });
    act(() => {
      findInput(
        renderer,
        'indicator-settings-stoch-rsi-length',
      ).props.onChangeText('10');
      findInput(
        renderer,
        'indicator-settings-stochastic-length',
      ).props.onChangeText('12');
      findInput(
        renderer,
        'indicator-settings-stoch-k-smoothing',
      ).props.onChangeText('2');
      findInput(
        renderer,
        'indicator-settings-stoch-d-smoothing',
      ).props.onChangeText('4');
    });
    act(() => {
      renderer.root
        .findByProps({ testID: 'indicator-settings-apply' })
        .props.onPress();
    });
    expect(onApply).toHaveBeenCalledWith({
      ...selectedPreferences,
      profiles: {
        ...selectedPreferences.profiles,
        SAR: { start: 0.01, increment: 0.02, maximum: 0.2 },
        StochRSI: {
          rsiLength: 10,
          stochasticLength: 12,
          kSmoothing: 2,
          dSmoothing: 4,
        },
      },
    });
    act(() => renderer.unmount());
  });
});
