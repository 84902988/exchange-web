import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  cloneAdvancedChartPreferences,
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  parseAdvancedChartPreferencesV2,
  type AdvancedChartPreferencesV2,
} from './advancedChartConfig';

export const ADVANCED_CHART_PREFERENCES_KEY =
  'mobile.advanced_chart.preferences.v2';

export type AdvancedChartPreferencesReadStatus =
  | 'valid'
  | 'missing'
  | 'malformed'
  | 'future_version'
  | 'read_error';

export type AdvancedChartPreferencesReadResult = {
  preferences: AdvancedChartPreferencesV2;
  status: AdvancedChartPreferencesReadStatus;
  writeProtected: boolean;
};

let writeTail: Promise<void> = Promise.resolve();
let latestWriteSequence = 0;

function defaultReadResult(
  status: Exclude<AdvancedChartPreferencesReadStatus, 'valid'>,
  writeProtected = false,
): AdvancedChartPreferencesReadResult {
  return {
    preferences: cloneAdvancedChartPreferences(
      DEFAULT_ADVANCED_CHART_PREFERENCES,
    ),
    status,
    writeProtected,
  };
}

function hasFuturePreferenceVersion(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const version = (value as Record<string, unknown>).version;
  return (
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > DEFAULT_ADVANCED_CHART_PREFERENCES.version
  );
}

export async function readAdvancedChartPreferences(): Promise<AdvancedChartPreferencesReadResult> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(ADVANCED_CHART_PREFERENCES_KEY);
  } catch {
    // A transient read failure must not authorize an automatic destructive write.
    return defaultReadResult('read_error', true);
  }
  if (raw === null) return defaultReadResult('missing');

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return defaultReadResult('malformed');
  }
  if (hasFuturePreferenceVersion(decoded)) {
    return defaultReadResult('future_version', true);
  }
  const parsed = parseAdvancedChartPreferencesV2(decoded);
  if (!parsed) return defaultReadResult('malformed');
  return {
    preferences: cloneAdvancedChartPreferences(parsed),
    status: 'valid',
    writeProtected: false,
  };
}

export function writeAdvancedChartPreferences(
  preferences: AdvancedChartPreferencesV2,
) {
  const sequence = ++latestWriteSequence;
  const payload = JSON.stringify(preferences);
  const result = writeTail
    .catch(() => undefined)
    .then(async () => {
      if (sequence !== latestWriteSequence) return;
      try {
        await AsyncStorage.setItem(ADVANCED_CHART_PREFERENCES_KEY, payload);
      } catch {
        // Chart preferences are non-critical and fail open in memory.
      }
    });
  writeTail = result;
  return result;
}

export function resetAdvancedChartPreferenceQueueForTests() {
  writeTail = Promise.resolve();
  latestWriteSequence = 0;
}
