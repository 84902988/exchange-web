import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  type AdvancedChartPreferencesV2,
} from '../src/components/chart/advancedChartConfig';
import {
  ADVANCED_CHART_PREFERENCES_KEY,
  readAdvancedChartPreferences,
  resetAdvancedChartPreferenceQueueForTests,
  writeAdvancedChartPreferences,
} from '../src/components/chart/advancedChartPreferences';

describe('advanced chart preference storage', () => {
  beforeEach(async () => {
    resetAdvancedChartPreferenceQueueForTests();
    jest.restoreAllMocks();
    await AsyncStorage.clear();
  });

  it('restores valid preferences and fails open for malformed storage', async () => {
    const stored: AdvancedChartPreferencesV2 = {
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: {overlay: 'BOLL', pane: 'RSI'},
    };
    await AsyncStorage.setItem(
      ADVANCED_CHART_PREFERENCES_KEY,
      JSON.stringify(stored),
    );
    expect(await readAdvancedChartPreferences()).toEqual({
      preferences: stored,
      status: 'valid',
      writeProtected: false,
    });

    await AsyncStorage.setItem(ADVANCED_CHART_PREFERENCES_KEY, '{bad');
    expect(await readAdvancedChartPreferences()).toEqual({
      preferences: DEFAULT_ADVANCED_CHART_PREFERENCES,
      status: 'malformed',
      writeProtected: false,
    });
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await readAdvancedChartPreferences()).toEqual({
      preferences: DEFAULT_ADVANCED_CHART_PREFERENCES,
      status: 'read_error',
      writeProtected: true,
    });
  });

  it('detects an unknown future schema and protects it from automatic writes', async () => {
    await AsyncStorage.setItem(
      ADVANCED_CHART_PREFERENCES_KEY,
      JSON.stringify({version: 3, payload: {ownedByFutureClient: true}}),
    );

    expect(await readAdvancedChartPreferences()).toEqual({
      preferences: DEFAULT_ADVANCED_CHART_PREFERENCES,
      status: 'future_version',
      writeProtected: true,
    });
  });

  it('serializes rapid writes with the latest payload winning', async () => {
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const first: AdvancedChartPreferencesV2 = {
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: {overlay: 'EMA', pane: 'VOL'},
    };
    const latest: AdvancedChartPreferencesV2 = {
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: {overlay: 'BOLL', pane: 'MACD'},
    };
    await Promise.all([
      writeAdvancedChartPreferences(first),
      writeAdvancedChartPreferences(latest),
    ]);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(
      ADVANCED_CHART_PREFERENCES_KEY,
      JSON.stringify(latest),
    );
  });

  it('fails open when persistence rejects', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    await expect(
      writeAdvancedChartPreferences(DEFAULT_ADVANCED_CHART_PREFERENCES),
    ).resolves.toBeUndefined();
  });
});
