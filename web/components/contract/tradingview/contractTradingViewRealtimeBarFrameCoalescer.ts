export type ContractTradingViewCompleteRealtimeBar = Readonly<{
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>;

export type ContractTradingViewRealtimeBarFrameSource =
  | 'preview'
  | 'native-open'
  | 'native-closed';

export type ContractTradingViewRealtimeBarAuthority =
  | 'STORE'
  | 'LEGACY_FALLBACK'
  | 'PREVIEW';

export type ContractTradingViewRealtimeBarFrameCandidate = Readonly<{
  symbol: string;
  interval: string;
  source: ContractTradingViewRealtimeBarFrameSource;
  authority: ContractTradingViewRealtimeBarAuthority;
  bar: ContractTradingViewCompleteRealtimeBar;
}>;

type ContractTradingViewRealtimeBarFrameCoalescerOptions = Readonly<{
  windowMs?: number;
  onFlush: (candidate: ContractTradingViewRealtimeBarFrameCandidate) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}>;

type PendingRealtimeBar = {
  key: string;
  candidate: ContractTradingViewRealtimeBarFrameCandidate;
  timer: unknown;
};

const DEFAULT_FRAME_WINDOW_MS = 12;
const MIN_FRAME_WINDOW_MS = 8;
const MAX_FRAME_WINDOW_MS = 16;

const SOURCE_PRIORITY: Record<ContractTradingViewRealtimeBarFrameSource, number> = {
  preview: 1,
  'native-open': 1,
  'native-closed': 2,
};

function normalizeSymbol(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeInterval(value: string): string {
  return String(value || '').trim();
}

function buildPendingKey(candidate: ContractTradingViewRealtimeBarFrameCandidate): string {
  return [
    normalizeSymbol(candidate.symbol),
    normalizeInterval(candidate.interval),
    candidate.bar.time,
  ].join(':');
}

function isCompleteBar(bar: ContractTradingViewCompleteRealtimeBar): boolean {
  const values = [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume];
  if (!values.every(Number.isFinite)) return false;
  if (
    bar.time <= 0
    || bar.open <= 0
    || bar.high <= 0
    || bar.low <= 0
    || bar.close <= 0
    || bar.volume < 0
  ) {
    return false;
  }
  return (
    bar.high >= Math.max(bar.open, bar.low, bar.close)
    && bar.low <= Math.min(bar.open, bar.high, bar.close)
  );
}

function cloneCandidate(
  candidate: ContractTradingViewRealtimeBarFrameCandidate,
): ContractTradingViewRealtimeBarFrameCandidate {
  return {
    ...candidate,
    symbol: normalizeSymbol(candidate.symbol),
    interval: normalizeInterval(candidate.interval),
    bar: { ...candidate.bar },
  };
}

export class ContractTradingViewRealtimeBarFrameCoalescer {
  readonly windowMs: number;
  private readonly onFlush: ContractTradingViewRealtimeBarFrameCoalescerOptions['onFlush'];
  private readonly schedule: NonNullable<
    ContractTradingViewRealtimeBarFrameCoalescerOptions['schedule']
  >;
  private readonly cancelSchedule: NonNullable<
    ContractTradingViewRealtimeBarFrameCoalescerOptions['cancelSchedule']
  >;
  private pending: PendingRealtimeBar | null = null;

  constructor(options: ContractTradingViewRealtimeBarFrameCoalescerOptions) {
    const requestedWindow = Number(options.windowMs);
    this.windowMs = Number.isFinite(requestedWindow)
      ? Math.min(MAX_FRAME_WINDOW_MS, Math.max(MIN_FRAME_WINDOW_MS, requestedWindow))
      : DEFAULT_FRAME_WINDOW_MS;
    this.onFlush = options.onFlush;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  }

  enqueue(candidate: ContractTradingViewRealtimeBarFrameCandidate): boolean {
    if (!isCompleteBar(candidate.bar)) return false;

    const nextCandidate = cloneCandidate(candidate);
    const key = buildPendingKey(nextCandidate);
    const current = this.pending;

    if (current && current.key !== key) {
      if (nextCandidate.bar.time < current.candidate.bar.time) return false;
      this.flush();
    }

    if (!this.pending) {
      this.pending = {
        key,
        candidate: nextCandidate,
        timer: this.schedule(() => this.flush(), this.windowMs),
      };
    } else {
      const currentPriority = SOURCE_PRIORITY[this.pending.candidate.source];
      const nextPriority = SOURCE_PRIORITY[nextCandidate.source];
      if (nextPriority < currentPriority) return false;
      this.pending.candidate = nextCandidate;
    }

    if (nextCandidate.source === 'native-closed') this.flush();
    return true;
  }

  flush(): boolean {
    const current = this.pending;
    if (!current) return false;

    this.pending = null;
    this.cancelSchedule(current.timer);
    this.onFlush(cloneCandidate(current.candidate));
    return true;
  }

  cancel(): void {
    const current = this.pending;
    this.pending = null;
    if (current) this.cancelSchedule(current.timer);
  }
}
