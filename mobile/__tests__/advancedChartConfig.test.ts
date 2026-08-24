import {
  configFromPreferences,
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  parseAdvancedChartIndicatorConfigV2,
  parseAdvancedChartPreferencesV2,
} from '../src/components/chart/advancedChartConfig';

describe('advanced chart config v2', () => {
  it('accepts the complete indicator profile schema', () => {
    expect(
      parseAdvancedChartPreferencesV2(DEFAULT_ADVANCED_CHART_PREFERENCES),
    ).toEqual(DEFAULT_ADVANCED_CHART_PREFERENCES);
    expect(configFromPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES)).toEqual({
      protocolVersion: 2,
      overlay: {kind: 'MA', params: {length: 9}},
      pane: {kind: 'VOL', params: {showMA: false, maLength: 20}},
    });
  });

  it('migrates the legacy six-profile schema without losing selections', () => {
    const parsed = parseAdvancedChartPreferencesV2({
      version: 2,
      selection: {overlay: 'EMA', pane: 'RSI'},
      profiles: {
        MA: {length: 9},
        EMA: {length: 21},
        BOLL: {length: 20, multiplier: 2},
        VOL: {showMA: false, maLength: 20},
        MACD: {fastLength: 12, slowLength: 26, signalLength: 9},
        RSI: {length: 10},
      },
    });

    expect(parsed?.selection).toEqual({overlay: 'EMA', pane: 'RSI'});
    expect(parsed?.profiles).toEqual({
      ...DEFAULT_ADVANCED_CHART_PREFERENCES.profiles,
      EMA: {length: 21},
      RSI: {length: 10},
    });
  });

  it('migrates saved empty profiles from the previous indicator schema', () => {
    const parsed = parseAdvancedChartPreferencesV2({
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: {overlay: 'SAR', pane: 'StochRSI'},
      profiles: {
        ...DEFAULT_ADVANCED_CHART_PREFERENCES.profiles,
        SAR: {},
        AVL: {},
        SUPER: {},
        KDJ: {},
        OBV: {},
        WR: {},
        StochRSI: {},
      },
    });

    expect(parsed).toEqual({
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: {overlay: 'SAR', pane: 'StochRSI'},
    });
  });

  it.each([
    {overlay: 'SAR' as const, pane: 'KDJ' as const},
    {overlay: 'AVL' as const, pane: 'OBV' as const},
    {overlay: 'SUPER' as const, pane: 'WR' as const},
    {overlay: 'MA' as const, pane: 'StochRSI' as const},
  ])('accepts configurable indicators %#', selection => {
    const preferences = {...DEFAULT_ADVANCED_CHART_PREFERENCES, selection};
    expect(parseAdvancedChartIndicatorConfigV2(configFromPreferences(preferences))).toEqual({
      protocolVersion: 2,
      overlay: {
        kind: selection.overlay,
        params: preferences.profiles[selection.overlay],
      },
      pane: {
        kind: selection.pane,
        params: preferences.profiles[selection.pane],
      },
    });
  });

  it.each([
    {overlay: {kind: 'MA', params: {length: 0}}},
    {overlay: {kind: 'EMA', params: {length: 501}}},
    {overlay: {kind: 'BOLL', params: {length: 20, multiplier: 2.25}}},
    {pane: {kind: 'VOL', params: {showMA: true, maLength: 0}}},
    {
      pane: {
        kind: 'MACD',
        params: {fastLength: 26, slowLength: 12, signalLength: 9},
      },
    },
    {pane: {kind: 'RSI', params: {length: 201}}},
    {
      overlay: {
        kind: 'SAR',
        params: {start: 0.02, increment: 0.02, maximum: 0.01},
      },
    },
    {overlay: {kind: 'AVL', params: {length: 501}}},
    {overlay: {kind: 'SUPER', params: {length: 0, multiplier: 3}}},
    {pane: {kind: 'KDJ', params: {length: 9, kSmoothing: 0, dSmoothing: 3}}},
    {pane: {kind: 'OBV', params: {maLength: -1}}},
    {pane: {kind: 'WR', params: {length: 0}}},
    {
      pane: {
        kind: 'StochRSI',
        params: {
          rsiLength: 14,
          stochasticLength: 14,
          kSmoothing: 3,
          dSmoothing: 0,
        },
      },
    },
  ])('rejects invalid protocol ranges %#', partial => {
    const valid = configFromPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES);
    expect(
      parseAdvancedChartIndicatorConfigV2({...valid, ...partial}),
    ).toBeNull();
  });

  it('rejects extra keys and non-version-2 payloads', () => {
    const valid = configFromPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES);
    expect(parseAdvancedChartIndicatorConfigV2({...valid, extra: true})).toBeNull();
    expect(
      parseAdvancedChartIndicatorConfigV2({...valid, protocolVersion: 1}),
    ).toBeNull();
  });
});
