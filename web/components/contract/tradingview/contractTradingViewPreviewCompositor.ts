export type ContractPreviewRevision = Readonly<{
  epoch: number;
  sequence: number;
}>;

export type ContractPreviewBar = Readonly<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type ContractPreviewNativeInput = Readonly<{
  symbol: string;
  interval: string;
  openTime: number;
  generation: number;
  receivedAtMs: number;
  revision: ContractPreviewRevision;
  isClosed: boolean;
  bar: ContractPreviewBar;
}>;

export type ContractPreviewInput = Readonly<{
  symbol: string;
  interval: string;
  openTime: number;
  generation: number;
  receivedAtMs: number;
  previewSequence: number;
  baseNativeRevision: ContractPreviewRevision;
  bar: ContractPreviewBar;
}>;

export type ContractPreviewReason =
  | 'NATIVE_ACCEPTED'
  | 'NATIVE_OPEN_DEFERRED_TO_PREVIEW'
  | 'PREVIEW_ACCEPTED'
  | 'SYMBOL_MISMATCH'
  | 'INTERVAL_MISMATCH'
  | 'UNSUPPORTED_SCOPE'
  | 'INVALID_BAR'
  | 'NATIVE_MISSING'
  | 'NATIVE_STALE'
  | 'NATIVE_CLOSED'
  | 'GENERATION_MISMATCH'
  | 'OPEN_TIME_MISMATCH'
  | 'OPEN_MISMATCH'
  | 'BASE_REVISION_STALE'
  | 'BASE_REVISION_FUTURE'
  | 'PREVIEW_VOLUME_STALE'
  | 'PREVIEW_SEQUENCE_STALE';

export type ContractPreviewResult = Readonly<{
  accepted: boolean;
  reason: ContractPreviewReason;
  source: 'native' | 'preview' | null;
  bar: ContractPreviewBar | null;
}>;

type State = {
  native: ContractPreviewNativeInput | null;
  preview: ContractPreviewInput | null;
};

const SUPPORTED_INTERVAL = '1m';
const VALID_SYMBOL = /^[A-Z0-9][A-Z0-9_-]*$/;

function normalizeSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeInterval(value: unknown) {
  return String(value ?? '').trim();
}

function isNonNegativeInteger(value: number) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number) {
  return Number.isInteger(value) && value > 0;
}

function isValidRevision(revision: ContractPreviewRevision) {
  return isNonNegativeInteger(revision.epoch) && isNonNegativeInteger(revision.sequence);
}

function isValidBar(bar: ContractPreviewBar, openTime: number) {
  if (!isPositiveInteger(openTime) || bar.time !== openTime) return false;
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume];
  if (!values.every(Number.isFinite)) return false;
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0) {
    return false;
  }
  return (
    bar.high >= Math.max(bar.open, bar.low, bar.close)
    && bar.low <= Math.min(bar.open, bar.high, bar.close)
  );
}

function compareRevision(left: ContractPreviewRevision, right: ContractPreviewRevision) {
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;
  if (left.sequence === right.sequence) return 0;
  return left.sequence < right.sequence ? -1 : 1;
}

function previewIsNewer(preview: ContractPreviewInput, native: ContractPreviewNativeInput) {
  // Native OPEN and trade preview arrive on independent provider channels.
  // A higher Native volume cannot advance the visible close ahead of the
  // Header's settled trade; wait until both channels agree on close.
  if (preview.bar.close !== native.bar.close) return true;
  if (preview.bar.volume !== native.bar.volume) {
    return preview.bar.volume > native.bar.volume;
  }
  return preview.receivedAtMs > native.receivedAtMs;
}

export class ContractTradingViewPreviewCompositor {
  readonly symbol: string;
  readonly interval: string;
  readonly supported: boolean;
  private state: State = { native: null, preview: null };

  constructor(scope: { symbol: string; interval: string }) {
    this.symbol = normalizeSymbol(scope.symbol);
    this.interval = normalizeInterval(scope.interval);
    this.supported = VALID_SYMBOL.test(this.symbol) && this.interval === SUPPORTED_INTERVAL;
  }

  acceptNative(input: ContractPreviewNativeInput): ContractPreviewResult {
    const scopeReason = this.validateScope(input.symbol, input.interval);
    if (scopeReason) return this.reject(scopeReason);
    if (!this.supported) return this.reject('UNSUPPORTED_SCOPE');
    if (
      !isPositiveInteger(input.generation)
      || !isPositiveInteger(input.receivedAtMs)
      || !isValidRevision(input.revision)
      || !isValidBar(input.bar, input.openTime)
    ) return this.reject('INVALID_BAR');

    const current = this.state.native;
    if (current) {
      if (input.openTime < current.openTime || input.generation < current.generation) {
        return this.reject('NATIVE_STALE');
      }
      if (
        input.openTime === current.openTime
        && input.generation === current.generation
        && compareRevision(input.revision, current.revision) < 0
      ) return this.reject('NATIVE_STALE');
      if (current.isClosed && input.openTime === current.openTime && !input.isClosed) {
        return this.reject('NATIVE_CLOSED');
      }
    }

    const nextNative: ContractPreviewNativeInput = {
      ...input,
      symbol: this.symbol,
      interval: this.interval,
      revision: { ...input.revision },
      bar: { ...input.bar },
    };
    this.state.native = nextNative;
    const preview = this.state.preview;
    if (
      !input.isClosed
      && preview
      && preview.openTime === input.openTime
      && preview.generation === input.generation
      && previewIsNewer(preview, nextNative)
    ) {
      return this.accept('NATIVE_OPEN_DEFERRED_TO_PREVIEW', 'preview', preview.bar);
    }
    if (
      input.isClosed
      || !preview
      || preview.openTime !== input.openTime
      || preview.generation !== input.generation
      || compareRevision(preview.baseNativeRevision, input.revision) !== 0
    ) this.state.preview = null;
    return this.accept('NATIVE_ACCEPTED', 'native', input.bar);
  }

  acceptPreview(input: ContractPreviewInput): ContractPreviewResult {
    const scopeReason = this.validateScope(input.symbol, input.interval);
    if (scopeReason) return this.reject(scopeReason);
    if (!this.supported) return this.reject('UNSUPPORTED_SCOPE');
    if (
      !isPositiveInteger(input.generation)
      || !isPositiveInteger(input.receivedAtMs)
      || !isPositiveInteger(input.previewSequence)
      || !isValidRevision(input.baseNativeRevision)
      || !isValidBar(input.bar, input.openTime)
    ) return this.reject('INVALID_BAR');

    const native = this.state.native;
    if (!native) return this.reject('NATIVE_MISSING');
    if (native.isClosed) return this.reject('NATIVE_CLOSED');
    if (input.generation !== native.generation) return this.reject('GENERATION_MISMATCH');
    if (input.openTime !== native.openTime) return this.reject('OPEN_TIME_MISMATCH');
    if (input.bar.open !== native.bar.open) return this.reject('OPEN_MISMATCH');
    const comparison = compareRevision(input.baseNativeRevision, native.revision);
    if (comparison < 0) return this.reject('BASE_REVISION_STALE');
    if (comparison > 0) return this.reject('BASE_REVISION_FUTURE');
    if (input.bar.volume < native.bar.volume) return this.reject('PREVIEW_VOLUME_STALE');

    const current = this.state.preview;
    if (current) {
      const samePreviewBaseline = compareRevision(
        current.baseNativeRevision,
        input.baseNativeRevision,
      ) === 0;
      if (samePreviewBaseline && input.previewSequence <= current.previewSequence) {
        return this.reject('PREVIEW_SEQUENCE_STALE');
      }
      if (
        input.openTime === current.openTime
        && input.generation === current.generation
        && input.bar.volume < current.bar.volume
      ) {
        return this.reject('PREVIEW_VOLUME_STALE');
      }
    }
    this.state.preview = {
      ...input,
      symbol: this.symbol,
      interval: this.interval,
      baseNativeRevision: { ...input.baseNativeRevision },
      bar: { ...input.bar },
    };
    return this.accept('PREVIEW_ACCEPTED', 'preview', input.bar);
  }

  reset() {
    this.state = { native: null, preview: null };
  }

  private validateScope(symbol: string, interval: string) {
    if (normalizeSymbol(symbol) !== this.symbol) return 'SYMBOL_MISMATCH' as const;
    if (normalizeInterval(interval) !== this.interval) return 'INTERVAL_MISMATCH' as const;
    return null;
  }

  private accept(
    reason: ContractPreviewReason,
    source: 'native' | 'preview',
    bar: ContractPreviewBar,
  ): ContractPreviewResult {
    return { accepted: true, reason, source, bar: { ...bar } };
  }

  private reject(reason: ContractPreviewReason): ContractPreviewResult {
    return { accepted: false, reason, source: null, bar: null };
  }
}
