export type SpotChartLoadingClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type SpotChartLoadingCoordinatorOptions = {
  onChange: (reason: string) => void;
  onSettled?: (token: SpotChartLoadingToken) => void;
  clock?: SpotChartLoadingClock;
  minVisibleMs?: number;
  safetyTimeoutMs?: number;
};

export type SpotChartLoadingToken = Readonly<{
  widgetGeneration: number;
  sequence: number;
  intent: string;
  startedAt: number;
}>;

export type SpotResolutionIntent = Readonly<{
  resolution: string;
  intentId: number;
}>;

export type SpotResolutionIntentToken = Readonly<{
  resolution: string;
  intentId: number;
  requestSequence: number;
}>;

export type SpotResolutionIntentSnapshot = Readonly<{
  currentResolution: string;
  inFlightResolution: string;
  pendingResolution: SpotResolutionIntent | null;
  latestIntentId: number;
  requestSequence: number;
}>;

export type SpotResolutionIntentRegistration = Readonly<{
  intent: SpotResolutionIntent;
  snapshot: SpotResolutionIntentSnapshot;
}>;

export type SpotResolutionIntentDecision = Readonly<{
  action: 'start' | 'pending' | 'noop' | 'stale';
  token?: SpotResolutionIntentToken;
  snapshot: SpotResolutionIntentSnapshot;
}>;

export type SpotResolutionIntentSettlement = Readonly<{
  accepted: boolean;
  nextToken?: SpotResolutionIntentToken;
  snapshot: SpotResolutionIntentSnapshot;
}>;

type SpotResolutionChart = {
  setResolution?: (
    resolution: string,
    options?: { dataReady?: () => void } | (() => void),
  ) => Promise<boolean> | boolean | void;
  resolution?: () => string;
};

type SpotResolutionRequestOptions = {
  chart: SpotResolutionChart | null | undefined;
  resolution: string;
  isCurrent: () => boolean;
  onCommitted: (reason: string) => void;
  onFailed: (reason: string, error?: unknown) => void;
  clock?: SpotChartLoadingClock;
  timeoutMs?: number;
};

export const SPOT_CHART_LOADING_MIN_VISIBLE_MS = 220;
export const SPOT_CHART_LOADING_SAFETY_TIMEOUT_MS = 5_000;
export const SPOT_SET_RESOLUTION_TIMEOUT_MS = 4_500;

export function shouldStartSpotChartResolutionChange(params: {
  widgetAvailable: boolean;
  chartReady: boolean;
  currentResolution: string;
  nextResolution: string;
}) {
  return Boolean(
    params.widgetAvailable
    && params.chartReady
    && params.nextResolution
    && params.currentResolution !== params.nextResolution
  );
}

export function setSpotToolbarLoadingState(
  toolbarSlot: HTMLElement | null,
  buttons: Map<string, HTMLButtonElement>,
  options: {
    loading: boolean;
    pendingKey?: string;
  },
) {
  if (toolbarSlot) {
    toolbarSlot.style.pointerEvents = 'auto';
    toolbarSlot.removeAttribute('aria-disabled');
    if ('disabled' in toolbarSlot) {
      const interactiveSlot = toolbarSlot as HTMLButtonElement;
      interactiveSlot.disabled = false;
      interactiveSlot.tabIndex = 0;
    }
    if (options.loading) {
      toolbarSlot.setAttribute('aria-busy', 'true');
    } else {
      toolbarSlot.removeAttribute('aria-busy');
    }
  }
  for (const [key, button] of buttons.entries()) {
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.tabIndex = 0;
    if (options.loading && options.pendingKey === key) {
      button.setAttribute('data-resolution-pending', 'true');
      button.style.boxShadow = 'inset 0 -2px 0 #f0b90b';
    } else {
      button.removeAttribute('data-resolution-pending');
      button.style.boxShadow = '';
    }
  }
}

export class SpotResolutionIntentCoordinator {
  private currentResolution = '';
  private inFlightResolution = '';
  private pendingResolution: SpotResolutionIntent | null = null;
  private latestIntentValue: SpotResolutionIntent | null = null;
  private latestIntentId = 0;
  private requestSequence = 0;

  constructor(currentResolution = '', initialIntentId = 0) {
    this.currentResolution = String(currentResolution || '');
    this.latestIntentId = Math.max(0, Math.floor(initialIntentId));
  }

  private snapshotValue(): SpotResolutionIntentSnapshot {
    return {
      currentResolution: this.currentResolution,
      inFlightResolution: this.inFlightResolution,
      pendingResolution: this.pendingResolution,
      latestIntentId: this.latestIntentId,
      requestSequence: this.requestSequence,
    };
  }

  private start(intent: SpotResolutionIntent): SpotResolutionIntentToken {
    this.requestSequence += 1;
    this.inFlightResolution = intent.resolution;
    return {
      ...intent,
      requestSequence: this.requestSequence,
    };
  }

  reset(currentResolution = '') {
    this.requestSequence += 1;
    this.latestIntentId += 1;
    this.currentResolution = String(currentResolution || '');
    this.inFlightResolution = '';
    this.pendingResolution = null;
    this.latestIntentValue = null;
    return this.snapshotValue();
  }

  snapshot() {
    return this.snapshotValue();
  }

  latestIntent() {
    return this.latestIntentValue;
  }

  registerIntent(resolution: string): SpotResolutionIntentRegistration {
    const nextResolution = String(resolution || '');
    this.latestIntentId += 1;
    const intent: SpotResolutionIntent = {
      resolution: nextResolution,
      intentId: this.latestIntentId,
    };
    this.latestIntentValue = intent;
    this.pendingResolution = nextResolution
      && nextResolution !== (this.inFlightResolution || this.currentResolution)
      ? intent
      : null;
    return { intent, snapshot: this.snapshotValue() };
  }

  isLatestIntent(intent: SpotResolutionIntent | null | undefined) {
    return Boolean(
      intent
      && intent.intentId === this.latestIntentId
      && intent.resolution === this.latestIntentValue?.resolution
      && intent.intentId === this.latestIntentValue?.intentId
    );
  }

  request(
    intent: SpotResolutionIntent,
    options: { canStart?: boolean } = {},
  ): SpotResolutionIntentDecision {
    const nextResolution = String(intent.resolution || '');
    if (!this.isLatestIntent(intent)) {
      return { action: 'stale', snapshot: this.snapshotValue() };
    }
    if (!nextResolution) {
      return { action: 'noop', snapshot: this.snapshotValue() };
    }

    if (this.inFlightResolution) {
      this.pendingResolution = nextResolution === this.inFlightResolution ? null : intent;
      return {
        action: this.pendingResolution ? 'pending' : 'noop',
        snapshot: this.snapshotValue(),
      };
    }

    if (options.canStart === false) {
      this.pendingResolution = nextResolution === this.currentResolution ? null : intent;
      return {
        action: this.pendingResolution ? 'pending' : 'noop',
        snapshot: this.snapshotValue(),
      };
    }

    if (nextResolution === this.currentResolution) {
      if (this.pendingResolution?.intentId === intent.intentId) {
        this.pendingResolution = null;
      }
      return { action: 'noop', snapshot: this.snapshotValue() };
    }

    if (this.pendingResolution?.intentId === intent.intentId) {
      this.pendingResolution = null;
    }
    const token = this.start(intent);
    return { action: 'start', token, snapshot: this.snapshotValue() };
  }

  drainPending(): SpotResolutionIntentDecision {
    if (this.inFlightResolution || !this.pendingResolution) {
      return { action: 'noop', snapshot: this.snapshotValue() };
    }
    const pendingIntent = this.pendingResolution;
    this.pendingResolution = null;
    if (!this.isLatestIntent(pendingIntent)) {
      return { action: 'stale', snapshot: this.snapshotValue() };
    }
    if (pendingIntent.resolution === this.currentResolution) {
      return { action: 'noop', snapshot: this.snapshotValue() };
    }
    const token = this.start(pendingIntent);
    return { action: 'start', token, snapshot: this.snapshotValue() };
  }

  isCurrent(token: SpotResolutionIntentToken | null | undefined) {
    return Boolean(
      token
      && token.requestSequence === this.requestSequence
      && token.intentId > 0
      && token.resolution === this.inFlightResolution
    );
  }

  canStart(token: SpotResolutionIntentToken | null | undefined) {
    return Boolean(this.isCurrent(token) && this.isLatestIntent(token));
  }

  commit(token: SpotResolutionIntentToken): SpotResolutionIntentSettlement {
    if (!this.isCurrent(token)) {
      return { accepted: false, snapshot: this.snapshotValue() };
    }
    this.currentResolution = token.resolution;
    this.inFlightResolution = '';
    const decision = this.drainPending();
    return {
      accepted: true,
      nextToken: decision.token,
      snapshot: decision.snapshot,
    };
  }

  fail(token: SpotResolutionIntentToken): SpotResolutionIntentSettlement {
    if (!this.isCurrent(token)) {
      return { accepted: false, snapshot: this.snapshotValue() };
    }
    this.inFlightResolution = '';
    const decision = this.drainPending();
    return {
      accepted: true,
      nextToken: decision.token,
      snapshot: decision.snapshot,
    };
  }
}

function defaultClock(): SpotChartLoadingClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export class SpotChartLoadingCoordinator {
  private readonly onChange: (reason: string) => void;
  private readonly onSettled?: (token: SpotChartLoadingToken) => void;
  private readonly clock: SpotChartLoadingClock;
  private readonly minVisibleMs: number;
  private readonly safetyTimeoutMs: number;
  private sequence = 0;
  private activeToken: SpotChartLoadingToken | null = null;
  private finishScheduledSequence = 0;
  private settledSequence = 0;
  private finishTimer: unknown = null;
  private safetyTimer: unknown = null;
  private destroyed = false;

  constructor({
    onChange,
    onSettled,
    clock,
    minVisibleMs = SPOT_CHART_LOADING_MIN_VISIBLE_MS,
    safetyTimeoutMs = SPOT_CHART_LOADING_SAFETY_TIMEOUT_MS,
  }: SpotChartLoadingCoordinatorOptions) {
    this.onChange = onChange;
    this.onSettled = onSettled;
    this.clock = clock || defaultClock();
    this.minVisibleMs = minVisibleMs;
    this.safetyTimeoutMs = safetyTimeoutMs;
  }

  private clearTimers() {
    if (this.finishTimer !== null) {
      this.clock.clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private isTokenCurrent(token: SpotChartLoadingToken) {
    return Boolean(
      !this.destroyed
      && this.activeToken
      && this.activeToken.widgetGeneration === token.widgetGeneration
      && this.activeToken.sequence === token.sequence
    );
  }

  start(widgetGeneration: number, intent: string): SpotChartLoadingToken {
    if (this.destroyed) {
      return {
        widgetGeneration,
        sequence: this.sequence,
        intent,
        startedAt: this.clock.now(),
      };
    }
    this.clearTimers();
    this.sequence += 1;
    const token: SpotChartLoadingToken = {
      widgetGeneration,
      sequence: this.sequence,
      intent,
      startedAt: this.clock.now(),
    };
    this.activeToken = token;
    this.finishScheduledSequence = 0;
    this.settledSequence = 0;
    this.onChange(intent);
    this.safetyTimer = this.clock.setTimeout(() => {
      this.safetyTimer = null;
      this.finish(token);
    }, this.safetyTimeoutMs);
    return token;
  }

  finish(token: SpotChartLoadingToken | null | undefined) {
    if (
      !token
      || !this.isTokenCurrent(token)
      || this.finishScheduledSequence === token.sequence
    ) {
      return false;
    }

    this.finishScheduledSequence = token.sequence;
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    const elapsedMs = Math.max(0, this.clock.now() - token.startedAt);
    const delayMs = Math.max(0, this.minVisibleMs - elapsedMs);
    this.finishTimer = this.clock.setTimeout(() => {
      this.finishTimer = null;
      if (!this.isTokenCurrent(token)) return;
      this.settledSequence = token.sequence;
      this.activeToken = null;
      this.onChange('');
      this.onSettled?.(token);
    }, delayMs);
    return true;
  }

  currentToken() {
    return this.activeToken;
  }

  isActive(token: SpotChartLoadingToken | null | undefined = this.activeToken) {
    return Boolean(
      token
      && this.isTokenCurrent(token)
      && this.settledSequence !== token.sequence
    );
  }

  retireGeneration(widgetGeneration: number) {
    const token = this.activeToken;
    if (!token || token.widgetGeneration !== widgetGeneration) return false;
    this.clearTimers();
    this.activeToken = null;
    this.finishScheduledSequence = 0;
    this.settledSequence = 0;
    this.onChange('');
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.sequence += 1;
    this.activeToken = null;
    this.finishScheduledSequence = 0;
    this.settledSequence = 0;
    this.clearTimers();
  }
}

export function requestSpotSetResolution({
  chart,
  resolution,
  isCurrent,
  onCommitted,
  onFailed,
  clock = defaultClock(),
  timeoutMs = SPOT_SET_RESOLUTION_TIMEOUT_MS,
}: SpotResolutionRequestOptions) {
  const activeChart = chart;
  let finished = false;
  let timeoutHandle: unknown = null;

  const readActualResolution = () => {
    try {
      return typeof activeChart?.resolution === 'function'
        ? String(activeChart.resolution() || '')
        : '';
    } catch {
      return '';
    }
  };

  const clearRequestTimeout = () => {
    if (timeoutHandle !== null) {
      clock.clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const commitOnce = (reason: string, authoritative = false) => {
    if (finished) return;
    const actualResolution = readActualResolution();
    if (!authoritative && actualResolution && actualResolution !== resolution) {
      failOnce('setResolution commit mismatch');
      return;
    }
    finished = true;
    clearRequestTimeout();
    if (isCurrent()) onCommitted(reason);
  };

  const failOnce = (reason: string, error?: unknown) => {
    if (finished) return;
    finished = true;
    clearRequestTimeout();
    if (isCurrent()) onFailed(reason, error);
  };

  const setResolution = activeChart?.setResolution;
  if (!activeChart || typeof setResolution !== 'function') {
    failOnce('setResolution unavailable');
    return () => undefined;
  }

  timeoutHandle = clock.setTimeout(() => {
    timeoutHandle = null;
    const actualResolution = readActualResolution();
    if (actualResolution === resolution) {
      commitOnce('setResolution timeout confirmed by chart resolution');
      return;
    }
    failOnce('setResolution timeout');
  }, Math.max(0, timeoutMs));

  try {
    const result = setResolution.call(activeChart, resolution, {
      dataReady: () => commitOnce('dataReady', true),
    });
    if (result === false) {
      failOnce('setResolution returned false');
    } else if (result === true) {
      commitOnce('setResolution returned true');
    } else if (result && typeof result.then === 'function') {
      void result.then((changed) => {
        if (changed === false) {
          failOnce('setResolution returned false');
          return;
        }
        commitOnce('setResolution promise resolved');
      }).catch((error: unknown) => {
        failOnce('setResolution rejected', error);
      });
    }
  } catch (error) {
    failOnce('setResolution threw', error);
  }

  return () => {
    if (finished) return;
    finished = true;
    clearRequestTimeout();
  };
}
