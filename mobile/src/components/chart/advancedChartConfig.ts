import type {
  AdvancedChartIndicators,
} from './advancedChartUrl';

export const ADVANCED_CHART_CONFIG_PROTOCOL_VERSION = 2 as const;
export const ADVANCED_CHART_CONFIG_CAPABILITY = 'indicator-config-v2' as const;

export type AdvancedChartIndicatorProfiles = {
  MA: {length: number};
  EMA: {length: number};
  BOLL: {length: number; multiplier: number};
  SAR: {start: number; increment: number; maximum: number};
  AVL: {length: number};
  SUPER: {length: number; multiplier: number};
  VOL: {showMA: boolean; maLength: number};
  MACD: {fastLength: number; slowLength: number; signalLength: number};
  RSI: {length: number};
  KDJ: {length: number; kSmoothing: number; dSmoothing: number};
  OBV: {maLength: number};
  WR: {length: number};
  StochRSI: {
    rsiLength: number;
    stochasticLength: number;
    kSmoothing: number;
    dSmoothing: number;
  };
};

export type AdvancedChartOverlayConfig =
  | {kind: 'MA'; params: AdvancedChartIndicatorProfiles['MA']}
  | {kind: 'EMA'; params: AdvancedChartIndicatorProfiles['EMA']}
  | {kind: 'BOLL'; params: AdvancedChartIndicatorProfiles['BOLL']}
  | {kind: 'SAR'; params: AdvancedChartIndicatorProfiles['SAR']}
  | {kind: 'AVL'; params: AdvancedChartIndicatorProfiles['AVL']}
  | {kind: 'SUPER'; params: AdvancedChartIndicatorProfiles['SUPER']};

export type AdvancedChartPaneConfig =
  | {kind: 'VOL'; params: AdvancedChartIndicatorProfiles['VOL']}
  | {kind: 'MACD'; params: AdvancedChartIndicatorProfiles['MACD']}
  | {kind: 'RSI'; params: AdvancedChartIndicatorProfiles['RSI']}
  | {kind: 'KDJ'; params: AdvancedChartIndicatorProfiles['KDJ']}
  | {kind: 'OBV'; params: AdvancedChartIndicatorProfiles['OBV']}
  | {kind: 'WR'; params: AdvancedChartIndicatorProfiles['WR']}
  | {kind: 'StochRSI'; params: AdvancedChartIndicatorProfiles['StochRSI']};

export type AdvancedChartIndicatorConfigV2 = {
  protocolVersion: 2;
  overlay: AdvancedChartOverlayConfig;
  pane: AdvancedChartPaneConfig;
};

export type AdvancedChartPreferencesV2 = {
  version: 2;
  selection: AdvancedChartIndicators;
  profiles: AdvancedChartIndicatorProfiles;
};

export const DEFAULT_ADVANCED_CHART_PREFERENCES: AdvancedChartPreferencesV2 = {
  version: 2,
  selection: {overlay: 'MA', pane: 'VOL'},
  profiles: {
    MA: {length: 9},
    EMA: {length: 9},
    BOLL: {length: 20, multiplier: 2},
    SAR: {start: 0.02, increment: 0.02, maximum: 0.2},
    AVL: {length: 0},
    SUPER: {length: 10, multiplier: 3},
    VOL: {showMA: false, maLength: 20},
    MACD: {fastLength: 12, slowLength: 26, signalLength: 9},
    RSI: {length: 14},
    KDJ: {length: 9, kSmoothing: 3, dSmoothing: 3},
    OBV: {maLength: 0},
    WR: {length: 14},
    StochRSI: {
      rsiLength: 14,
      stochasticLength: 14,
      kSmoothing: 3,
      dSmoothing: 3,
    },
  },
};

const profileKeys = [
  'MA',
  'EMA',
  'BOLL',
  'SAR',
  'AVL',
  'SUPER',
  'VOL',
  'MACD',
  'RSI',
  'KDJ',
  'OBV',
  'WR',
  'StochRSI',
] as const satisfies readonly (keyof AdvancedChartIndicatorProfiles)[];

const legacyProfileKeys = ['MA', 'EMA', 'BOLL', 'VOL', 'MACD', 'RSI'] as const;

const legacyDefaultProfileKinds = new Set<keyof AdvancedChartIndicatorProfiles>([
  'SAR',
  'AVL',
  'SUPER',
  'KDJ',
  'OBV',
  'WR',
  'StochRSI',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isMultiplier(value: unknown) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0.1 &&
    value <= 10 &&
    Math.round(value * 10) === value * 10
  );
}

function isHundredthInRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    Math.abs(value * 100 - Math.round(value * 100)) < Number.EPSILON * 100
  );
}

function parseProfile<K extends keyof AdvancedChartIndicatorProfiles>(
  kind: K,
  value: unknown,
): AdvancedChartIndicatorProfiles[K] | null {
  if (!isRecord(value)) return null;
  if (legacyDefaultProfileKinds.has(kind) && hasExactKeys(value, [])) {
    return {
      ...DEFAULT_ADVANCED_CHART_PREFERENCES.profiles[kind],
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'MA' || kind === 'EMA') {
    if (!hasExactKeys(value, ['length']) || !isIntegerInRange(value.length, 1, 500)) {
      return null;
    }
    return {length: value.length} as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'BOLL') {
    if (
      !hasExactKeys(value, ['length', 'multiplier']) ||
      !isIntegerInRange(value.length, 1, 500) ||
      !isMultiplier(value.multiplier)
    ) {
      return null;
    }
    return {
      length: value.length,
      multiplier: value.multiplier,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'SAR') {
    if (
      !hasExactKeys(value, ['start', 'increment', 'maximum']) ||
      !isHundredthInRange(value.start, 0.01, 0.2) ||
      !isHundredthInRange(value.increment, 0.01, 0.2) ||
      !isHundredthInRange(value.maximum, 0.1, 1) ||
      Number(value.start) > Number(value.maximum) ||
      Number(value.increment) > Number(value.maximum)
    ) {
      return null;
    }
    return {
      start: value.start,
      increment: value.increment,
      maximum: value.maximum,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'AVL') {
    if (!hasExactKeys(value, ['length']) || !isIntegerInRange(value.length, 0, 500)) {
      return null;
    }
    return {length: value.length} as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'SUPER') {
    if (
      !hasExactKeys(value, ['length', 'multiplier']) ||
      !isIntegerInRange(value.length, 1, 100) ||
      !isMultiplier(value.multiplier) ||
      Number(value.multiplier) < 1
    ) {
      return null;
    }
    return {
      length: value.length,
      multiplier: value.multiplier,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'VOL') {
    if (
      !hasExactKeys(value, ['showMA', 'maLength']) ||
      typeof value.showMA !== 'boolean' ||
      !isIntegerInRange(value.maLength, 1, 500)
    ) {
      return null;
    }
    return {
      showMA: value.showMA,
      maLength: value.maLength,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'MACD') {
    if (
      !hasExactKeys(value, ['fastLength', 'slowLength', 'signalLength']) ||
      !isIntegerInRange(value.fastLength, 1, 200) ||
      !isIntegerInRange(value.slowLength, 1, 200) ||
      Number(value.fastLength) >= Number(value.slowLength) ||
      !isIntegerInRange(value.signalLength, 1, 50)
    ) {
      return null;
    }
    return {
      fastLength: value.fastLength,
      slowLength: value.slowLength,
      signalLength: value.signalLength,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'KDJ') {
    if (
      !hasExactKeys(value, ['length', 'kSmoothing', 'dSmoothing']) ||
      !isIntegerInRange(value.length, 1, 200) ||
      !isIntegerInRange(value.kSmoothing, 1, 50) ||
      !isIntegerInRange(value.dSmoothing, 1, 50)
    ) {
      return null;
    }
    return {
      length: value.length,
      kSmoothing: value.kSmoothing,
      dSmoothing: value.dSmoothing,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'OBV') {
    if (!hasExactKeys(value, ['maLength']) || !isIntegerInRange(value.maLength, 0, 500)) {
      return null;
    }
    return {maLength: value.maLength} as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'WR') {
    if (!hasExactKeys(value, ['length']) || !isIntegerInRange(value.length, 1, 200)) {
      return null;
    }
    return {length: value.length} as AdvancedChartIndicatorProfiles[K];
  }
  if (kind === 'StochRSI') {
    if (
      !hasExactKeys(value, [
        'rsiLength',
        'stochasticLength',
        'kSmoothing',
        'dSmoothing',
      ]) ||
      !isIntegerInRange(value.rsiLength, 1, 200) ||
      !isIntegerInRange(value.stochasticLength, 1, 200) ||
      !isIntegerInRange(value.kSmoothing, 1, 50) ||
      !isIntegerInRange(value.dSmoothing, 1, 50)
    ) {
      return null;
    }
    return {
      rsiLength: value.rsiLength,
      stochasticLength: value.stochasticLength,
      kSmoothing: value.kSmoothing,
      dSmoothing: value.dSmoothing,
    } as AdvancedChartIndicatorProfiles[K];
  }
  if (
    !hasExactKeys(value, ['length']) ||
    !isIntegerInRange(value.length, 1, 200)
  ) {
    return null;
  }
  return {length: value.length} as AdvancedChartIndicatorProfiles[K];
}

function parseOverlay(value: unknown): AdvancedChartOverlayConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'params'])) return null;
  if (
    value.kind !== 'MA' &&
    value.kind !== 'EMA' &&
    value.kind !== 'BOLL' &&
    value.kind !== 'SAR' &&
    value.kind !== 'AVL' &&
    value.kind !== 'SUPER'
  ) {
    return null;
  }
  const params = parseProfile(value.kind, value.params);
  return params ? ({kind: value.kind, params} as AdvancedChartOverlayConfig) : null;
}

function parsePane(value: unknown): AdvancedChartPaneConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'params'])) return null;
  if (
    value.kind !== 'VOL' &&
    value.kind !== 'MACD' &&
    value.kind !== 'RSI' &&
    value.kind !== 'KDJ' &&
    value.kind !== 'OBV' &&
    value.kind !== 'WR' &&
    value.kind !== 'StochRSI'
  ) {
    return null;
  }
  const params = parseProfile(value.kind, value.params);
  return params ? ({kind: value.kind, params} as AdvancedChartPaneConfig) : null;
}

export function parseAdvancedChartIndicatorConfigV2(
  value: unknown,
): AdvancedChartIndicatorConfigV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'overlay', 'pane']) ||
    value.protocolVersion !== ADVANCED_CHART_CONFIG_PROTOCOL_VERSION
  ) {
    return null;
  }
  const overlay = parseOverlay(value.overlay);
  const pane = parsePane(value.pane);
  return overlay && pane
    ? {protocolVersion: 2, overlay, pane}
    : null;
}

export function parseAdvancedChartPreferencesV2(
  value: unknown,
): AdvancedChartPreferencesV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'selection', 'profiles']) ||
    value.version !== 2 ||
    !isRecord(value.selection) ||
    !hasExactKeys(value.selection, ['overlay', 'pane']) ||
    !isRecord(value.profiles)
  ) {
    return null;
  }
  const savedProfileKeys = Object.keys(value.profiles);
  if (
    legacyProfileKeys.some(key => !savedProfileKeys.includes(key)) ||
    savedProfileKeys.some(key => !profileKeys.includes(key as typeof profileKeys[number]))
  ) {
    return null;
  }
  const overlay = value.selection.overlay;
  const pane = value.selection.pane;
  if (
    (overlay !== 'MA' &&
      overlay !== 'EMA' &&
      overlay !== 'BOLL' &&
      overlay !== 'SAR' &&
      overlay !== 'AVL' &&
      overlay !== 'SUPER') ||
    (pane !== 'VOL' &&
      pane !== 'MACD' &&
      pane !== 'RSI' &&
      pane !== 'KDJ' &&
      pane !== 'OBV' &&
      pane !== 'WR' &&
      pane !== 'StochRSI')
  ) {
    return null;
  }
  const profiles = {
    MA: parseProfile('MA', value.profiles.MA),
    EMA: parseProfile('EMA', value.profiles.EMA),
    BOLL: parseProfile('BOLL', value.profiles.BOLL),
    SAR: parseProfile('SAR', value.profiles.SAR ?? {}),
    AVL: parseProfile('AVL', value.profiles.AVL ?? {}),
    SUPER: parseProfile('SUPER', value.profiles.SUPER ?? {}),
    VOL: parseProfile('VOL', value.profiles.VOL),
    MACD: parseProfile('MACD', value.profiles.MACD),
    RSI: parseProfile('RSI', value.profiles.RSI),
    KDJ: parseProfile('KDJ', value.profiles.KDJ ?? {}),
    OBV: parseProfile('OBV', value.profiles.OBV ?? {}),
    WR: parseProfile('WR', value.profiles.WR ?? {}),
    StochRSI: parseProfile('StochRSI', value.profiles.StochRSI ?? {}),
  };
  if (Object.values(profiles).some(profile => profile === null)) return null;
  return {
    version: 2,
    selection: {overlay, pane},
    profiles: profiles as AdvancedChartIndicatorProfiles,
  };
}

export function configFromPreferences(
  preferences: AdvancedChartPreferencesV2,
): AdvancedChartIndicatorConfigV2 {
  const overlay = preferences.selection.overlay;
  const pane = preferences.selection.pane;
  return {
    protocolVersion: 2,
    overlay: {kind: overlay, params: {...preferences.profiles[overlay]}} as AdvancedChartOverlayConfig,
    pane: {kind: pane, params: {...preferences.profiles[pane]}} as AdvancedChartPaneConfig,
  };
}

export function selectionFromConfig(
  config: AdvancedChartIndicatorConfigV2,
): AdvancedChartIndicators {
  return {overlay: config.overlay.kind, pane: config.pane.kind};
}

export function mergeConfigIntoPreferences(
  preferences: AdvancedChartPreferencesV2,
  config: AdvancedChartIndicatorConfigV2,
): AdvancedChartPreferencesV2 {
  return {
    version: 2,
    selection: selectionFromConfig(config),
    profiles: {
      ...preferences.profiles,
      [config.overlay.kind]: {...config.overlay.params},
      [config.pane.kind]: {...config.pane.params},
    },
  };
}

export function defaultConfigForSelection(
  selection: AdvancedChartIndicators,
): AdvancedChartIndicatorConfigV2 {
  return configFromPreferences({
    ...DEFAULT_ADVANCED_CHART_PREFERENCES,
    selection,
  });
}

export function cloneAdvancedChartPreferences(
  value: AdvancedChartPreferencesV2,
): AdvancedChartPreferencesV2 {
  return JSON.parse(JSON.stringify(value)) as AdvancedChartPreferencesV2;
}
