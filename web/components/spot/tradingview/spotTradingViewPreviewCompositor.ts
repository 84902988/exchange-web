export type SpotPreviewCompositorRevision = Readonly<{
  epoch: number;
  sequence: number;
}>;

export type SpotPreviewCompositorBar = Readonly<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type SpotPreviewCompositorNativeInput = Readonly<{
  symbol: string;
  interval: string;
  openTime: number;
  generation: number;
  receivedAtMs: number;
  revision: SpotPreviewCompositorRevision;
  isClosed: boolean;
  bar: SpotPreviewCompositorBar;
}>;

export type SpotPreviewCompositorPreviewInput = Readonly<{
  symbol: string;
  interval: string;
  openTime: number;
  generation: number;
  receivedAtMs: number;
  previewSeq: number;
  baseNativeRevision: SpotPreviewCompositorRevision;
  bar: SpotPreviewCompositorBar;
}>;

export type SpotPreviewCompositorFreshnessState = Readonly<{
  symbol: string;
  interval: string;
  openTime: number | null;
  previewSeq: number | null;
  nativeRevisionSeq: number | null;
  previewReceivedAt: number | null;
  nativeReceivedAt: number | null;
}>;

export type SpotPreviewCompositorReason =
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
  | 'PREVIEW_TRADE_STATE_STALE'
  | 'PREVIEW_SEQUENCE_STALE';

export type SpotPreviewCompositorResult = Readonly<{
  accepted: boolean;
  reason: SpotPreviewCompositorReason;
  source: 'native' | 'preview' | null;
  bar: SpotPreviewCompositorBar | null;
}>;

type SpotPreviewCompositorState = {
  native: SpotPreviewCompositorNativeInput | null;
  preview: SpotPreviewCompositorPreviewInput | null;
};

type MutableSpotPreviewCompositorFreshnessState = {
  symbol: string;
  interval: string;
  openTime: number | null;
  previewSeq: number | null;
  nativeRevisionSeq: number | null;
  previewReceivedAt: number | null;
  nativeReceivedAt: number | null;
};

const SUPPORTED_INTERVAL = '1m';

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeInterval(value: unknown): string {
  return String(value ?? '').trim();
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isValidRevision(revision: SpotPreviewCompositorRevision): boolean {
  return (
    isNonNegativeInteger(revision.epoch)
    && isNonNegativeInteger(revision.sequence)
  );
}

function isValidBar(bar: SpotPreviewCompositorBar, openTime: number): boolean {
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

function compareRevision(
  left: SpotPreviewCompositorRevision,
  right: SpotPreviewCompositorRevision,
): number {
  if (left.epoch !== right.epoch) return left.epoch < right.epoch ? -1 : 1;
  if (left.sequence === right.sequence) return 0;
  return left.sequence < right.sequence ? -1 : 1;
}

function cloneBar(bar: SpotPreviewCompositorBar): SpotPreviewCompositorBar {
  return { ...bar };
}

function isPreviewTradeStateNewer(
  preview: SpotPreviewCompositorPreviewInput,
  native: SpotPreviewCompositorNativeInput,
): boolean {
  // Native OPEN and trade preview arrive on independent provider channels.
  // Do not let volume-first Native evidence move the visible close ahead of
  // the Header's settled trade. CLOSED Native still wins in acceptNative().
  if (preview.bar.close !== native.bar.close) return true;
  if (preview.bar.volume !== native.bar.volume) {
    return preview.bar.volume > native.bar.volume;
  }
  return preview.receivedAtMs > native.receivedAtMs;
}

export class SpotTradingViewPreviewCompositor {
  readonly symbol: string;
  readonly interval: string;
  readonly supported: boolean;
  private state: SpotPreviewCompositorState = { native: null, preview: null };
  private freshnessState: MutableSpotPreviewCompositorFreshnessState;

  constructor(scope: { symbol: string; interval: string }) {
    this.symbol = normalizeSymbol(scope.symbol);
    this.interval = normalizeInterval(scope.interval);
    this.supported = Boolean(this.symbol) && this.interval === SUPPORTED_INTERVAL;
    this.freshnessState = {
      symbol: this.symbol,
      interval: this.interval,
      openTime: null,
      previewSeq: null,
      nativeRevisionSeq: null,
      previewReceivedAt: null,
      nativeReceivedAt: null,
    };
  }

  acceptNative(input: SpotPreviewCompositorNativeInput): SpotPreviewCompositorResult {
    const scopeReason = this.validateScope(input.symbol, input.interval);
    if (scopeReason) return this.reject(scopeReason);
    if (!this.supported) return this.reject('UNSUPPORTED_SCOPE');
    if (
      !isPositiveInteger(input.generation)
      || !isPositiveInteger(input.receivedAtMs)
      || !isValidRevision(input.revision)
      || !isValidBar(input.bar, input.openTime)
    ) {
      return this.reject('INVALID_BAR');
    }

    const current = this.state.native;
    if (current) {
      if (input.openTime < current.openTime) return this.reject('NATIVE_STALE');
      if (input.generation < current.generation) return this.reject('NATIVE_STALE');
      if (
        input.openTime === current.openTime
        && input.generation === current.generation
        && compareRevision(input.revision, current.revision) < 0
      ) {
        return this.reject('NATIVE_STALE');
      }
      if (
        current.isClosed
        && input.openTime === current.openTime
        && !input.isClosed
      ) {
        return this.reject('NATIVE_CLOSED');
      }
    }

    const nextNative: SpotPreviewCompositorNativeInput = {
      ...input,
      symbol: this.symbol,
      interval: this.interval,
      bar: cloneBar(input.bar),
      revision: { ...input.revision },
    };
    const previousOpenTime = this.freshnessState.openTime;
    this.state.native = nextNative;
    this.freshnessState.openTime = input.openTime;
    this.freshnessState.nativeRevisionSeq = input.revision.sequence;
    this.freshnessState.nativeReceivedAt = input.receivedAtMs;
    if (
      previousOpenTime !== input.openTime
      || current?.generation !== input.generation
      || input.isClosed
    ) {
      this.freshnessState.previewSeq = null;
      this.freshnessState.previewReceivedAt = null;
    }

    const preview = this.state.preview;
    if (
      !input.isClosed
      && preview
      && preview.openTime === input.openTime
      && preview.generation === input.generation
      && isPreviewTradeStateNewer(preview, nextNative)
    ) {
      return this.accept(
        'NATIVE_OPEN_DEFERRED_TO_PREVIEW',
        'preview',
        preview.bar,
      );
    }
    if (
      input.isClosed
      || !preview
      || preview.openTime !== input.openTime
      || preview.generation !== input.generation
      || compareRevision(preview.baseNativeRevision, input.revision) !== 0
    ) {
      this.state.preview = null;
    }
    return this.accept('NATIVE_ACCEPTED', 'native', input.bar);
  }

  acceptPreview(input: SpotPreviewCompositorPreviewInput): SpotPreviewCompositorResult {
    const scopeReason = this.validateScope(input.symbol, input.interval);
    if (scopeReason) return this.reject(scopeReason);
    if (!this.supported) return this.reject('UNSUPPORTED_SCOPE');
    if (
      !isPositiveInteger(input.generation)
      || !isPositiveInteger(input.receivedAtMs)
      || !isPositiveInteger(input.previewSeq)
      || !isValidRevision(input.baseNativeRevision)
      || !isValidBar(input.bar, input.openTime)
    ) {
      return this.reject('INVALID_BAR');
    }

    const native = this.state.native;
    if (!native) return this.reject('NATIVE_MISSING');
    if (native.isClosed) return this.reject('NATIVE_CLOSED');
    if (input.generation !== native.generation) {
      return this.reject('GENERATION_MISMATCH');
    }
    if (input.openTime !== native.openTime) {
      return this.reject('OPEN_TIME_MISMATCH');
    }
    if (input.bar.open !== native.bar.open) return this.reject('OPEN_MISMATCH');

    const baseComparison = compareRevision(input.baseNativeRevision, native.revision);
    if (baseComparison < 0) return this.reject('BASE_REVISION_STALE');
    if (baseComparison > 0) return this.reject('BASE_REVISION_FUTURE');
    if (input.bar.volume < native.bar.volume) {
      return this.reject('PREVIEW_TRADE_STATE_STALE');
    }

    const currentPreview = this.state.preview;
    if (currentPreview) {
      const samePreviewBaseline = compareRevision(
        currentPreview.baseNativeRevision,
        input.baseNativeRevision,
      ) === 0;
      if (samePreviewBaseline && input.previewSeq <= currentPreview.previewSeq) {
        return this.reject('PREVIEW_SEQUENCE_STALE');
      }
      if (
        input.openTime === currentPreview.openTime
        && input.generation === currentPreview.generation
        && input.bar.volume < currentPreview.bar.volume
      ) {
        return this.reject('PREVIEW_TRADE_STATE_STALE');
      }
    }

    this.state.preview = {
      ...input,
      symbol: this.symbol,
      interval: this.interval,
      bar: cloneBar(input.bar),
      baseNativeRevision: { ...input.baseNativeRevision },
    };
    this.freshnessState.openTime = input.openTime;
    this.freshnessState.previewSeq = input.previewSeq;
    this.freshnessState.previewReceivedAt = input.receivedAtMs;
    return this.accept('PREVIEW_ACCEPTED', 'preview', input.bar);
  }

  getOutput(): SpotPreviewCompositorResult {
    const native = this.state.native;
    if (!native) return this.reject('NATIVE_MISSING');
    const preview = this.state.preview;
    if (native.isClosed || !preview) {
      return this.accept('NATIVE_ACCEPTED', 'native', native.bar);
    }
    if (
      preview.openTime !== native.openTime
      || preview.generation !== native.generation
    ) {
      return this.accept('NATIVE_ACCEPTED', 'native', native.bar);
    }
    if (compareRevision(preview.baseNativeRevision, native.revision) === 0) {
      return this.accept('PREVIEW_ACCEPTED', 'preview', preview.bar);
    }
    if (isPreviewTradeStateNewer(preview, native)) {
      return this.accept('NATIVE_OPEN_DEFERRED_TO_PREVIEW', 'preview', preview.bar);
    }
    return this.accept('NATIVE_ACCEPTED', 'native', native.bar);
  }

  getFreshnessState(): SpotPreviewCompositorFreshnessState {
    return { ...this.freshnessState };
  }

  reset(): void {
    this.state = { native: null, preview: null };
    this.freshnessState = {
      symbol: this.symbol,
      interval: this.interval,
      openTime: null,
      previewSeq: null,
      nativeRevisionSeq: null,
      previewReceivedAt: null,
      nativeReceivedAt: null,
    };
  }

  private validateScope(
    symbol: string,
    interval: string,
  ): 'SYMBOL_MISMATCH' | 'INTERVAL_MISMATCH' | null {
    if (normalizeSymbol(symbol) !== this.symbol) return 'SYMBOL_MISMATCH';
    if (normalizeInterval(interval) !== this.interval) return 'INTERVAL_MISMATCH';
    return null;
  }

  private accept(
    reason: SpotPreviewCompositorReason,
    source: 'native' | 'preview',
    bar: SpotPreviewCompositorBar,
  ): SpotPreviewCompositorResult {
    return { accepted: true, reason, source, bar: cloneBar(bar) };
  }

  private reject(reason: SpotPreviewCompositorReason): SpotPreviewCompositorResult {
    return { accepted: false, reason, source: null, bar: null };
  }
}
