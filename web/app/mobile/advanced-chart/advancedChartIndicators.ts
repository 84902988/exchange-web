export const ADVANCED_CHART_OVERLAY_INDICATORS = [
  'MA',
  'EMA',
  'BOLL',
  'SAR',
  'AVL',
  'SUPER',
] as const;
export const ADVANCED_CHART_PANE_INDICATORS = [
  'VOL',
  'MACD',
  'RSI',
  'KDJ',
  'OBV',
  'WR',
  'StochRSI',
] as const;
export const ADVANCED_CHART_STUDY_CREATE_TIMEOUT_MS = 4_000;
export const ADVANCED_CHART_INDICATOR_PROTOCOL_VERSION = 2 as const;

export type AdvancedChartOverlayIndicator =
  typeof ADVANCED_CHART_OVERLAY_INDICATORS[number];
export type AdvancedChartPaneIndicator =
  typeof ADVANCED_CHART_PANE_INDICATORS[number];

export type AdvancedChartIndicatorSelection = Readonly<{
  overlay: AdvancedChartOverlayIndicator;
  pane: AdvancedChartPaneIndicator;
}>;

export type AdvancedChartOverlayConfig =
  | Readonly<{ kind: 'MA'; params: Readonly<{ length: number }> }>
  | Readonly<{ kind: 'EMA'; params: Readonly<{ length: number }> }>
  | Readonly<{
      kind: 'BOLL';
      params: Readonly<{ length: number; multiplier: number }>;
    }>
  | Readonly<{
      kind: 'SAR';
      params: Readonly<{ start: number; increment: number; maximum: number }>;
    }>
  | Readonly<{ kind: 'AVL'; params: Readonly<{ length: number }> }>
  | Readonly<{
      kind: 'SUPER';
      params: Readonly<{ length: number; multiplier: number }>;
    }>;

export type AdvancedChartPaneConfig =
  | Readonly<{
      kind: 'VOL';
      params: Readonly<{ showMA: boolean; maLength: number }>;
    }>
  | Readonly<{
      kind: 'MACD';
      params: Readonly<{
        fastLength: number;
        slowLength: number;
        signalLength: number;
      }>;
    }>
  | Readonly<{ kind: 'RSI'; params: Readonly<{ length: number }> }>
  | Readonly<{
      kind: 'KDJ';
      params: Readonly<{ length: number; kSmoothing: number; dSmoothing: number }>;
    }>
  | Readonly<{ kind: 'OBV'; params: Readonly<{ maLength: number }> }>
  | Readonly<{ kind: 'WR'; params: Readonly<{ length: number }> }>
  | Readonly<{
      kind: 'StochRSI';
      params: Readonly<{
        rsiLength: number;
        stochasticLength: number;
        kSmoothing: number;
        dSmoothing: number;
      }>;
    }>;

export type AdvancedChartIndicatorConfigV2 = Readonly<{
  protocolVersion: typeof ADVANCED_CHART_INDICATOR_PROTOCOL_VERSION;
  overlay: AdvancedChartOverlayConfig;
  pane: AdvancedChartPaneConfig;
}>;

export type AdvancedChartIndicatorCommand = Readonly<{
  type: 'mobile-chart-command';
  sessionId: string;
  command: 'set-indicators';
  intentId: number;
  indicators: AdvancedChartIndicatorSelection;
}>;

export type AdvancedChartIndicatorConfigCommandV2 = Readonly<{
  type: 'mobile-chart-command';
  sessionId: string;
  command: 'set-indicator-config-v2';
  intentId: number;
  config: AdvancedChartIndicatorConfigV2;
}>;

export type ParsedAdvancedChartIndicatorCommand =
  | AdvancedChartIndicatorCommand
  | AdvancedChartIndicatorConfigCommandV2;

export type AdvancedChartStudyEntityId = string | number;
export type AdvancedChartStudyInputValue = string | number | boolean;
export type AdvancedChartStudyInputValueItem = Readonly<{
  id: string;
  value: AdvancedChartStudyInputValue;
}>;

export type AdvancedChartStudyInstanceApi = Readonly<{
  getInputValues: () => readonly AdvancedChartStudyInputValueItem[];
}>;

export type AdvancedChartStudyApi = Readonly<{
  createStudy: (
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: Readonly<Record<string, AdvancedChartStudyInputValue>>,
    overrides?: Readonly<Record<string, AdvancedChartStudyInputValue>>,
    options?: Readonly<{ disableUndo?: boolean }>,
  ) => Promise<AdvancedChartStudyEntityId | null>;
  removeEntity: (
    entityId: AdvancedChartStudyEntityId,
    options?: { disableUndo?: boolean },
  ) => void;
  getAllStudies: () => readonly Readonly<{
    id: AdvancedChartStudyEntityId;
    name: string;
  }>[];
  // Production callers require this capability before attaching. Optionality keeps
  // the legacy controller adapter structurally compatible for isolated tests only.
  getStudyById?: (entityId: AdvancedChartStudyEntityId) => AdvancedChartStudyInstanceApi;
}>;

type IndicatorGroup = 'overlay' | 'pane';
type IndicatorKey = AdvancedChartOverlayIndicator | AdvancedChartPaneIndicator;
type IndicatorGroupConfig = AdvancedChartOverlayConfig | AdvancedChartPaneConfig;
type ResponseProtocol = 'v1' | 'v2';

type StudyDefinition = Readonly<{
  group: IndicatorGroup;
  name: string;
  forceOverlay: boolean;
}>;

const STUDY_DEFINITIONS: Readonly<Record<IndicatorKey, StudyDefinition>> = {
  MA: { group: 'overlay', name: 'Moving Average', forceOverlay: true },
  EMA: { group: 'overlay', name: 'Moving Average Exponential', forceOverlay: true },
  BOLL: { group: 'overlay', name: 'Bollinger Bands', forceOverlay: true },
  SAR: { group: 'overlay', name: 'Parabolic SAR', forceOverlay: true },
  AVL: { group: 'overlay', name: 'VWAP', forceOverlay: true },
  SUPER: { group: 'overlay', name: 'SuperTrend', forceOverlay: true },
  VOL: { group: 'pane', name: 'Volume', forceOverlay: false },
  MACD: { group: 'pane', name: 'MACD', forceOverlay: false },
  RSI: { group: 'pane', name: 'Relative Strength Index', forceOverlay: false },
  KDJ: { group: 'pane', name: 'KDJ', forceOverlay: false },
  OBV: { group: 'pane', name: 'On Balance Volume', forceOverlay: false },
  WR: { group: 'pane', name: 'Williams %R', forceOverlay: false },
  StochRSI: { group: 'pane', name: 'Stochastic RSI', forceOverlay: false },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function isSingleDecimalInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max
    && Math.abs((value * 10) - Math.round(value * 10)) < Number.EPSILON * 10;
}

function isHundredthInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max
    && Math.abs((value * 100) - Math.round(value * 100)) < Number.EPSILON * 100;
}

function legacyOverlayParams(kind: 'SAR' | 'AVL' | 'SUPER'): AdvancedChartOverlayConfig {
  if (kind === 'SAR') {
    return { kind, params: { start: 0.02, increment: 0.02, maximum: 0.2 } };
  }
  if (kind === 'AVL') return { kind, params: { length: 0 } };
  return { kind, params: { length: 10, multiplier: 3 } };
}

function legacyPaneParams(
  kind: 'KDJ' | 'OBV' | 'WR' | 'StochRSI',
): AdvancedChartPaneConfig {
  if (kind === 'KDJ') {
    return { kind, params: { length: 9, kSmoothing: 3, dSmoothing: 3 } };
  }
  if (kind === 'OBV') return { kind, params: { maLength: 0 } };
  if (kind === 'WR') return { kind, params: { length: 14 } };
  return {
    kind,
    params: {
      rsiLength: 14,
      stochasticLength: 14,
      kSmoothing: 3,
      dSmoothing: 3,
    },
  };
}

function isOverlayIndicator(value: unknown): value is AdvancedChartOverlayIndicator {
  return ADVANCED_CHART_OVERLAY_INDICATORS.includes(
    value as AdvancedChartOverlayIndicator,
  );
}

function isPaneIndicator(value: unknown): value is AdvancedChartPaneIndicator {
  return ADVANCED_CHART_PANE_INDICATORS.includes(
    value as AdvancedChartPaneIndicator,
  );
}

function parseOverlayConfig(value: unknown): AdvancedChartOverlayConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'params']) || !isRecord(value.params)) {
    return null;
  }
  if (value.kind === 'MA' || value.kind === 'EMA') {
    if (!hasExactKeys(value.params, ['length']) || !isIntegerInRange(value.params.length, 1, 500)) {
      return null;
    }
    return { kind: value.kind, params: { length: value.params.length } };
  }
  if (value.kind === 'BOLL') {
    if (
      !hasExactKeys(value.params, ['length', 'multiplier'])
      || !isIntegerInRange(value.params.length, 1, 500)
      || !isSingleDecimalInRange(value.params.multiplier, 0.1, 10)
    ) return null;
    return {
      kind: 'BOLL',
      params: {
        length: value.params.length,
        multiplier: value.params.multiplier,
      },
    };
  }
  if (value.kind === 'SAR') {
    if (hasExactKeys(value.params, [])) return legacyOverlayParams('SAR');
    if (
      !hasExactKeys(value.params, ['start', 'increment', 'maximum'])
      || !isHundredthInRange(value.params.start, 0.01, 0.2)
      || !isHundredthInRange(value.params.increment, 0.01, 0.2)
      || !isHundredthInRange(value.params.maximum, 0.1, 1)
      || value.params.start > value.params.maximum
      || value.params.increment > value.params.maximum
    ) return null;
    return {
      kind: 'SAR',
      params: {
        start: value.params.start,
        increment: value.params.increment,
        maximum: value.params.maximum,
      },
    };
  }
  if (value.kind === 'AVL') {
    if (hasExactKeys(value.params, [])) return legacyOverlayParams('AVL');
    if (!hasExactKeys(value.params, ['length']) || !isIntegerInRange(value.params.length, 0, 500)) {
      return null;
    }
    return { kind: 'AVL', params: { length: value.params.length } };
  }
  if (value.kind === 'SUPER') {
    if (hasExactKeys(value.params, [])) return legacyOverlayParams('SUPER');
    if (
      !hasExactKeys(value.params, ['length', 'multiplier'])
      || !isIntegerInRange(value.params.length, 1, 100)
      || !isSingleDecimalInRange(value.params.multiplier, 1, 10)
    ) return null;
    return {
      kind: 'SUPER',
      params: { length: value.params.length, multiplier: value.params.multiplier },
    };
  }
  return null;
}

function parsePaneConfig(value: unknown): AdvancedChartPaneConfig | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'params']) || !isRecord(value.params)) {
    return null;
  }
  if (value.kind === 'VOL') {
    if (
      !hasExactKeys(value.params, ['showMA', 'maLength'])
      || typeof value.params.showMA !== 'boolean'
      || !isIntegerInRange(value.params.maLength, 1, 500)
    ) return null;
    return {
      kind: 'VOL',
      params: { showMA: value.params.showMA, maLength: value.params.maLength },
    };
  }
  if (value.kind === 'MACD') {
    if (
      !hasExactKeys(value.params, ['fastLength', 'slowLength', 'signalLength'])
      || !isIntegerInRange(value.params.fastLength, 1, 200)
      || !isIntegerInRange(value.params.slowLength, 1, 200)
      || value.params.fastLength >= value.params.slowLength
      || !isIntegerInRange(value.params.signalLength, 1, 50)
    ) return null;
    return {
      kind: 'MACD',
      params: {
        fastLength: value.params.fastLength,
        slowLength: value.params.slowLength,
        signalLength: value.params.signalLength,
      },
    };
  }
  if (value.kind === 'RSI') {
    if (!hasExactKeys(value.params, ['length']) || !isIntegerInRange(value.params.length, 1, 200)) {
      return null;
    }
    return { kind: 'RSI', params: { length: value.params.length } };
  }
  if (value.kind === 'KDJ') {
    if (hasExactKeys(value.params, [])) return legacyPaneParams('KDJ');
    if (
      !hasExactKeys(value.params, ['length', 'kSmoothing', 'dSmoothing'])
      || !isIntegerInRange(value.params.length, 1, 200)
      || !isIntegerInRange(value.params.kSmoothing, 1, 50)
      || !isIntegerInRange(value.params.dSmoothing, 1, 50)
    ) return null;
    return {
      kind: 'KDJ',
      params: {
        length: value.params.length,
        kSmoothing: value.params.kSmoothing,
        dSmoothing: value.params.dSmoothing,
      },
    };
  }
  if (value.kind === 'OBV') {
    if (hasExactKeys(value.params, [])) return legacyPaneParams('OBV');
    if (!hasExactKeys(value.params, ['maLength']) || !isIntegerInRange(value.params.maLength, 0, 500)) {
      return null;
    }
    return { kind: 'OBV', params: { maLength: value.params.maLength } };
  }
  if (value.kind === 'WR') {
    if (hasExactKeys(value.params, [])) return legacyPaneParams('WR');
    if (!hasExactKeys(value.params, ['length']) || !isIntegerInRange(value.params.length, 1, 200)) {
      return null;
    }
    return { kind: 'WR', params: { length: value.params.length } };
  }
  if (value.kind === 'StochRSI') {
    if (hasExactKeys(value.params, [])) return legacyPaneParams('StochRSI');
    if (
      !hasExactKeys(value.params, [
        'rsiLength',
        'stochasticLength',
        'kSmoothing',
        'dSmoothing',
      ])
      || !isIntegerInRange(value.params.rsiLength, 1, 200)
      || !isIntegerInRange(value.params.stochasticLength, 1, 200)
      || !isIntegerInRange(value.params.kSmoothing, 1, 50)
      || !isIntegerInRange(value.params.dSmoothing, 1, 50)
    ) return null;
    return {
      kind: 'StochRSI',
      params: {
        rsiLength: value.params.rsiLength,
        stochasticLength: value.params.stochasticLength,
        kSmoothing: value.params.kSmoothing,
        dSmoothing: value.params.dSmoothing,
      },
    };
  }
  return null;
}

export function parseAdvancedChartIndicatorConfigV2(
  value: unknown,
): AdvancedChartIndicatorConfigV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['protocolVersion', 'overlay', 'pane'])) {
    return null;
  }
  if (value.protocolVersion !== ADVANCED_CHART_INDICATOR_PROTOCOL_VERSION) return null;
  const overlay = parseOverlayConfig(value.overlay);
  const pane = parsePaneConfig(value.pane);
  if (!overlay || !pane) return null;
  return {
    protocolVersion: ADVANCED_CHART_INDICATOR_PROTOCOL_VERSION,
    overlay,
    pane,
  };
}

export function parseAdvancedChartIndicatorCommand(
  raw: unknown,
  expectedSessionId: string,
): ParsedAdvancedChartIndicatorCommand | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  if (
    value.type !== 'mobile-chart-command'
    || value.sessionId !== expectedSessionId
    || !Number.isSafeInteger(value.intentId)
    || Number(value.intentId) <= 0
  ) return null;

  if (value.command === 'set-indicators') {
    if (
      !hasExactKeys(value, ['type', 'sessionId', 'command', 'intentId', 'indicators'])
      || !isRecord(value.indicators)
      || !hasExactKeys(value.indicators, ['overlay', 'pane'])
      || !isOverlayIndicator(value.indicators.overlay)
      || !isPaneIndicator(value.indicators.pane)
    ) return null;
    return {
      type: 'mobile-chart-command',
      sessionId: expectedSessionId,
      command: 'set-indicators',
      intentId: Number(value.intentId),
      indicators: {
        overlay: value.indicators.overlay,
        pane: value.indicators.pane,
      },
    };
  }

  if (value.command === 'set-indicator-config-v2') {
    if (!hasExactKeys(value, ['type', 'sessionId', 'command', 'intentId', 'config'])) return null;
    const config = parseAdvancedChartIndicatorConfigV2(value.config);
    if (!config) return null;
    return {
      type: 'mobile-chart-command',
      sessionId: expectedSessionId,
      command: 'set-indicator-config-v2',
      intentId: Number(value.intentId),
      config,
    };
  }
  return null;
}

export function defaultAdvancedChartIndicatorConfig(
  selection: AdvancedChartIndicatorSelection,
): AdvancedChartIndicatorConfigV2 {
  let overlay: AdvancedChartOverlayConfig;
  switch (selection.overlay) {
    case 'MA':
      overlay = { kind: 'MA', params: { length: 9 } };
      break;
    case 'EMA':
      overlay = { kind: 'EMA', params: { length: 9 } };
      break;
    case 'BOLL':
      overlay = { kind: 'BOLL', params: { length: 20, multiplier: 2 } };
      break;
    case 'SAR':
      overlay = legacyOverlayParams('SAR');
      break;
    case 'AVL':
      overlay = legacyOverlayParams('AVL');
      break;
    case 'SUPER':
      overlay = legacyOverlayParams('SUPER');
      break;
  }
  let pane: AdvancedChartPaneConfig;
  switch (selection.pane) {
    case 'VOL':
      pane = { kind: 'VOL', params: { showMA: false, maLength: 20 } };
      break;
    case 'MACD':
      pane = {
        kind: 'MACD',
        params: { fastLength: 12, slowLength: 26, signalLength: 9 },
      };
      break;
    case 'RSI':
      pane = { kind: 'RSI', params: { length: 14 } };
      break;
    case 'KDJ':
      pane = legacyPaneParams('KDJ');
      break;
    case 'OBV':
      pane = legacyPaneParams('OBV');
      break;
    case 'WR':
      pane = legacyPaneParams('WR');
      break;
    case 'StochRSI':
      pane = legacyPaneParams('StochRSI');
      break;
  }
  return {
    protocolVersion: ADVANCED_CHART_INDICATOR_PROTOCOL_VERSION,
    overlay,
    pane,
  };
}

export function advancedChartConfigSelection(
  config: AdvancedChartIndicatorConfigV2,
): AdvancedChartIndicatorSelection {
  return { overlay: config.overlay.kind, pane: config.pane.kind };
}

export function advancedChartStudyInputs(
  config: IndicatorGroupConfig,
): Readonly<Record<string, AdvancedChartStudyInputValue>> {
  switch (config.kind) {
    case 'MA':
    case 'EMA':
      return {
        length: config.params.length,
        source: 'close',
        offset: 0,
        smoothingLine: 'SMA',
        smoothingLength: 9,
      };
    case 'BOLL':
      return {
        in_0: config.params.length,
        in_1: config.params.multiplier,
        offset: 0,
        maType: 'SMA',
      };
    case 'VOL':
      return {
        showMA: config.params.showMA,
        length: config.params.maLength,
        volumeMA: 'SMA',
        col_prev_close: false,
      };
    case 'MACD':
      return {
        in_0: config.params.fastLength,
        in_1: config.params.slowLength,
        in_2: config.params.signalLength,
        in_3: 'close',
        oscillatorMAType: 'EMA',
        signalLineMAType: 'EMA',
      };
    case 'RSI':
      return {
        length: config.params.length,
        smoothingLine: 'SMA',
        smoothingLength: 14,
      };
    case 'SAR':
      return {
        in_0: config.params.start,
        in_1: config.params.increment,
        in_2: config.params.maximum,
      };
    case 'AVL':
      // The bundled TradingView VWAP exposes anchor/source rather than a
      // rolling length. The native chart applies AVL length directly.
      return {};
    case 'SUPER':
      return { in_0: config.params.length, in_1: config.params.multiplier };
    case 'KDJ':
      return {
        in_0: config.params.length,
        in_1: config.params.kSmoothing,
        in_2: config.params.dSmoothing,
      };
    case 'OBV':
      return config.params.maLength > 0
        ? { smoothingLine: 'SMA', smoothingLength: config.params.maLength }
        : {};
    case 'WR':
      return { in_0: config.params.length };
    case 'StochRSI':
      return {
        in_0: config.params.rsiLength,
        in_1: config.params.stochasticLength,
        in_2: config.params.kSmoothing,
        in_3: config.params.dSmoothing,
      };
  }
}

function canonicalConfig(config: AdvancedChartIndicatorConfigV2): AdvancedChartIndicatorConfigV2 {
  const parsed = parseAdvancedChartIndicatorConfigV2(config);
  if (!parsed) throw new Error('invalid indicator config');
  return parsed;
}

function configFingerprint(config: AdvancedChartIndicatorConfigV2) {
  return JSON.stringify(config);
}

function groupFingerprint(config: IndicatorGroupConfig) {
  return JSON.stringify(config);
}

type AdvancedChartIndicatorControllerOptions = Readonly<{
  onCommitted: (
    intentId: number,
    selection: AdvancedChartIndicatorSelection,
  ) => void;
  onError: (
    intentId: number,
    message: string,
    indicators: AdvancedChartIndicatorSelection | null,
  ) => void;
  onConfigCommitted?: (
    intentId: number,
    config: AdvancedChartIndicatorConfigV2,
  ) => void;
  onConfigError?: (
    intentId: number,
    message: string,
    config: AdvancedChartIndicatorConfigV2 | null,
  ) => void;
  studyCreateTimeoutMs?: number;
}>;

type ActiveStudy = Readonly<{
  key: IndicatorKey;
  entityId: AdvancedChartStudyEntityId;
  fingerprint: string;
}>;

type PreparedStudyGroup = Readonly<{
  group: IndicatorGroup;
  key: IndicatorKey;
  recognized: readonly ActiveStudy[];
  selected: ActiveStudy;
  created: boolean;
}>;

type IndicatorRequest = Readonly<{
  protocol: ResponseProtocol;
  clientIntentId: number;
  config: AdvancedChartIndicatorConfigV2;
  fingerprint: string;
}>;

export class AdvancedChartIndicatorController {
  private chart: AdvancedChartStudyApi | null = null;
  private generation = 0;
  private intentSequence = 0;
  private active: Partial<Record<IndicatorGroup, ActiveStudy>> = {};
  private queue: Promise<void> = Promise.resolve();
  private lastRequest: IndicatorRequest | null = null;
  private lastRequestedClientIntentId = 0;
  private lastCommittedConfig: AdvancedChartIndicatorConfigV2 | null = null;
  private protectedSelectedEntityIds = new Map<
    AdvancedChartStudyApi,
    Set<AdvancedChartStudyEntityId>
  >();
  private deferredLateEntityIds = new Map<
    AdvancedChartStudyApi,
    Set<AdvancedChartStudyEntityId>
  >();
  private readonly studyCreateTimeoutMs: number;

  constructor(private readonly options: AdvancedChartIndicatorControllerOptions) {
    const requestedTimeout = Number(options.studyCreateTimeoutMs);
    this.studyCreateTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, ADVANCED_CHART_STUDY_CREATE_TIMEOUT_MS)
      : ADVANCED_CHART_STUDY_CREATE_TIMEOUT_MS;
  }

  attach(chart: AdvancedChartStudyApi | null) {
    if (this.chart === chart) return;
    if (this.chart) {
      this.flushDeferredLateEntities(this.chart);
      this.protectedSelectedEntityIds.delete(this.chart);
    }
    this.generation += 1;
    this.chart = chart;
    this.active = {};
    this.intentSequence += 1;
    this.queue = Promise.resolve();
    this.lastCommittedConfig = null;
    if (chart && this.lastRequest) this.enqueueRequest(this.lastRequest);
  }

  setIndicators(selection: AdvancedChartIndicatorSelection, clientIntentId: number) {
    return this.requestConfig(defaultAdvancedChartIndicatorConfig(selection), clientIntentId, 'v1');
  }

  setIndicatorConfig(config: AdvancedChartIndicatorConfigV2, clientIntentId: number) {
    let normalized: AdvancedChartIndicatorConfigV2;
    try {
      normalized = canonicalConfig(config);
    } catch {
      return false;
    }
    return this.requestConfig(normalized, clientIntentId, 'v2');
  }

  private requestConfig(
    config: AdvancedChartIndicatorConfigV2,
    clientIntentId: number,
    protocol: ResponseProtocol,
  ) {
    if (!Number.isSafeInteger(clientIntentId) || clientIntentId <= 0) return false;
    const fingerprint = configFingerprint(config);
    if (clientIntentId < this.lastRequestedClientIntentId) return false;
    if (
      clientIntentId === this.lastRequestedClientIntentId
      && this.lastRequest
      && (this.lastRequest.fingerprint !== fingerprint || this.lastRequest.protocol !== protocol)
    ) return false;
    this.lastRequestedClientIntentId = clientIntentId;
    const request: IndicatorRequest = { protocol, clientIntentId, config, fingerprint };
    this.lastRequest = request;
    if (!this.chart) {
      this.emitError(request, '图表尚未就绪');
      return false;
    }
    this.enqueueRequest(request);
    return true;
  }

  private enqueueRequest(request: IndicatorRequest) {
    if (!this.chart) return;
    const intent = ++this.intentSequence;
    const generation = this.generation;
    const chart = this.chart;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(chart, generation, intent)) return;
        const prepared: PreparedStudyGroup[] = [];
        try {
          prepared.push(await this.prepareGroup('overlay', request.config.overlay, chart, request.protocol));
          if (!this.isCurrent(chart, generation, intent)) {
            this.cleanupPreparedStudies(chart, prepared);
            return;
          }
          prepared.push(await this.prepareGroup('pane', request.config.pane, chart, request.protocol));
          if (!this.isCurrent(chart, generation, intent)) {
            this.cleanupPreparedStudies(chart, prepared);
            return;
          }

          for (const plan of prepared) {
            for (const study of plan.recognized) {
              if (study.entityId === plan.selected.entityId) continue;
              this.removeEntityBestEffort(chart, study.entityId);
            }
          }
          this.active = {
            overlay: prepared.find((plan) => plan.group === 'overlay')?.selected,
            pane: prepared.find((plan) => plan.group === 'pane')?.selected,
          };
          this.lastCommittedConfig = request.config;
          for (const plan of prepared) this.releaseProtection(chart, plan.selected.entityId);
        } catch (error) {
          this.cleanupPreparedStudies(chart, prepared);
          throw error;
        }
        this.emitCommitted(request);
      })
      .catch(() => {
        if (this.isCurrent(chart, generation, intent)) {
          this.emitError(
            request,
            request.protocol === 'v1' ? '技术指标切换失败' : '技术指标配置失败',
          );
        }
      });
  }

  private emitCommitted(request: IndicatorRequest) {
    try {
      if (request.protocol === 'v2') {
        this.options.onConfigCommitted?.(request.clientIntentId, request.config);
      } else {
        this.options.onCommitted(
          request.clientIntentId,
          advancedChartConfigSelection(request.config),
        );
      }
    } catch {
      // Bridge callbacks are observers of a completed chart transaction. A
      // transport failure must not roll back or invalidate committed studies.
    }
  }

  private emitError(request: IndicatorRequest, message: string) {
    try {
      if (request.protocol === 'v2') {
        this.options.onConfigError?.(
          request.clientIntentId,
          message,
          this.lastCommittedConfig,
        );
        return;
      }
      this.options.onError(
        request.clientIntentId,
        message,
        this.lastCommittedConfig ? advancedChartConfigSelection(this.lastCommittedConfig) : null,
      );
    } catch {
      // Reporting an error is best effort and must never poison the command queue.
    }
  }

  private isCurrent(
    chart: AdvancedChartStudyApi,
    generation: number,
    intent: number,
  ) {
    return this.chart === chart
      && this.generation === generation
      && this.intentSequence === intent;
  }

  private async prepareGroup(
    group: IndicatorGroup,
    config: IndicatorGroupConfig,
    chart: AdvancedChartStudyApi,
    protocol: ResponseProtocol,
  ): Promise<PreparedStudyGroup> {
    const existing = this.active[group];
    const recognized = chart.getAllStudies().flatMap((study) => {
      const matched = (Object.entries(STUDY_DEFINITIONS) as Array<
        [IndicatorKey, StudyDefinition]
      >).find(([, definition]) => (
        definition.group === group && definition.name === study.name
      ));
      return matched ? [{ key: matched[0], entityId: study.id, fingerprint: '' }] : [];
    });
    if (existing && !recognized.some((study) => study.entityId === existing.entityId)) {
      recognized.push(existing);
    }

    const key = config.kind;
    const definition = STUDY_DEFINITIONS[key];
    if (definition.group !== group) throw new Error('indicator group mismatch');
    const desiredFingerprint = groupFingerprint(config);
    for (const candidate of recognized.filter((study) => study.key === key)) {
      if (this.studyInputsMatch(chart, candidate.entityId, config, protocol)) {
        this.protectEntity(chart, candidate.entityId);
        return {
          group,
          key,
          recognized,
          selected: { key, entityId: candidate.entityId, fingerprint: desiredFingerprint },
          created: false,
        };
      }
    }

    const inputs = advancedChartStudyInputs(config);
    const entityId = await this.createStudyWithTimeout(
      chart,
      definition.name,
      definition.forceOverlay,
      inputs,
    );
    if (entityId === null || entityId === undefined) throw new Error('study creation failed');
    if (!this.studyInputsMatch(chart, entityId, config, protocol)) {
      const deferredCleaned = this.releaseProtection(chart, entityId);
      if (!deferredCleaned) this.removeEntityBestEffort(chart, entityId);
      throw new Error('study input verification failed');
    }
    return {
      group,
      key,
      recognized,
      selected: { key, entityId, fingerprint: desiredFingerprint },
      created: true,
    };
  }

  private studyInputsMatch(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
    config: IndicatorGroupConfig,
    protocol: ResponseProtocol,
  ) {
    if (!chart.getStudyById) return protocol === 'v1';
    try {
      const actual = new Map(
        chart.getStudyById(entityId).getInputValues().map((item) => [item.id, item.value]),
      );
      return Object.entries(advancedChartStudyInputs(config)).every(
        ([id, value]) => actual.has(id) && Object.is(actual.get(id), value),
      );
    } catch {
      return false;
    }
  }

  private cleanupPreparedStudies(
    chart: AdvancedChartStudyApi,
    prepared: readonly PreparedStudyGroup[],
  ) {
    for (const plan of prepared) {
      const deferredCleaned = this.releaseProtection(chart, plan.selected.entityId);
      if (plan.created && !deferredCleaned) {
        this.removeEntityBestEffort(chart, plan.selected.entityId);
      }
    }
  }

  private createStudyWithTimeout(
    chart: AdvancedChartStudyApi,
    name: string,
    forceOverlay: boolean,
    inputs: Readonly<Record<string, AdvancedChartStudyInputValue>>,
  ) {
    const creation = Promise.resolve().then(() => (
      chart.createStudy(
        name,
        forceOverlay,
        false,
        inputs,
        undefined,
        { disableUndo: true },
      )
    ));

    return new Promise<AdvancedChartStudyEntityId | null>((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('study creation timed out'));
      }, this.studyCreateTimeoutMs);

      void creation.then((entityId) => {
        if (settled) {
          if (entityId !== null && entityId !== undefined) this.cleanupLateEntity(chart, entityId);
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        if (entityId !== null && entityId !== undefined && this.chart === chart) {
          this.protectEntity(chart, entityId);
        }
        resolve(entityId);
      }).catch((error: unknown) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      });
    });
  }

  private cleanupLateEntity(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
  ) {
    if (this.chart === chart) {
      const isActive = Object.values(this.active).some(
        (study) => study?.entityId === entityId,
      );
      if (isActive) return;
      if (this.isProtected(chart, entityId)) {
        this.deferLateCleanup(chart, entityId);
        return;
      }
    }
    this.removeEntityBestEffort(chart, entityId);
  }

  private protectEntity(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
  ) {
    const protectedIds = this.protectedSelectedEntityIds.get(chart) ?? new Set();
    protectedIds.add(entityId);
    this.protectedSelectedEntityIds.set(chart, protectedIds);
  }

  private isProtected(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
  ) {
    return this.protectedSelectedEntityIds.get(chart)?.has(entityId) === true;
  }

  private deferLateCleanup(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
  ) {
    const deferredIds = this.deferredLateEntityIds.get(chart) ?? new Set();
    deferredIds.add(entityId);
    this.deferredLateEntityIds.set(chart, deferredIds);
  }

  private releaseProtection(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
  ) {
    const protectedIds = this.protectedSelectedEntityIds.get(chart);
    protectedIds?.delete(entityId);
    if (protectedIds?.size === 0) this.protectedSelectedEntityIds.delete(chart);

    const deferredIds = this.deferredLateEntityIds.get(chart);
    if (!deferredIds?.delete(entityId)) return false;
    if (deferredIds.size === 0) this.deferredLateEntityIds.delete(chart);
    const isActive = this.chart === chart && Object.values(this.active).some(
      (study) => study?.entityId === entityId,
    );
    if (isActive) return false;
    this.removeEntityBestEffort(chart, entityId);
    return true;
  }

  private flushDeferredLateEntities(chart: AdvancedChartStudyApi) {
    const deferredIds = this.deferredLateEntityIds.get(chart);
    if (!deferredIds) return;
    this.deferredLateEntityIds.delete(chart);
    for (const entityId of deferredIds) this.removeEntityBestEffort(chart, entityId);
  }

  private removeEntityBestEffort(
    chart: AdvancedChartStudyApi,
    entityId: AdvancedChartStudyEntityId,
  ) {
    try {
      chart.removeEntity(entityId, { disableUndo: true });
    } catch {
      // A retired TradingView generation may already be destroyed.
    }
  }
}
