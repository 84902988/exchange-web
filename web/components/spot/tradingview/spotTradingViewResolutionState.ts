export type SpotChartLoadingClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

type SpotChartLoadingCoordinatorOptions = {
  onChange: (reason: string) => void;
  onSettled?: (sequence: number) => void;
  clock?: SpotChartLoadingClock;
  minVisibleMs?: number;
  safetyTimeoutMs?: number;
};

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

export function setSpotToolbarDisabled(
  toolbarSlot: HTMLElement | null,
  buttons: Map<string, HTMLButtonElement>,
  disabled: boolean,
) {
  if (toolbarSlot) {
    if (disabled) {
      toolbarSlot.setAttribute('aria-disabled', 'true');
      toolbarSlot.style.pointerEvents = 'none';
    } else {
      toolbarSlot.removeAttribute('aria-disabled');
      toolbarSlot.style.pointerEvents = 'auto';
    }
  }
  for (const button of buttons.values()) {
    button.disabled = disabled;
    if (disabled) {
      button.setAttribute('aria-disabled', 'true');
      button.tabIndex = -1;
    } else {
      button.removeAttribute('aria-disabled');
      button.tabIndex = 0;
    }
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
  private readonly onSettled?: (sequence: number) => void;
  private readonly clock: SpotChartLoadingClock;
  private readonly minVisibleMs: number;
  private readonly safetyTimeoutMs: number;
  private sequence = 0;
  private startedAt = 0;
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

  start(reason: string) {
    if (this.destroyed) return this.sequence;
    this.clearTimers();
    this.sequence += 1;
    const sequence = this.sequence;
    this.startedAt = this.clock.now();
    this.finishScheduledSequence = 0;
    this.settledSequence = 0;
    this.onChange(reason);
    this.safetyTimer = this.clock.setTimeout(() => {
      this.safetyTimer = null;
      this.finish(sequence);
    }, this.safetyTimeoutMs);
    return sequence;
  }

  finish(sequence = this.sequence) {
    if (
      this.destroyed
      || sequence !== this.sequence
      || this.finishScheduledSequence === sequence
    ) {
      return false;
    }

    this.finishScheduledSequence = sequence;
    if (this.safetyTimer !== null) {
      this.clock.clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    const elapsedMs = Math.max(0, this.clock.now() - this.startedAt);
    const delayMs = Math.max(0, this.minVisibleMs - elapsedMs);
    this.finishTimer = this.clock.setTimeout(() => {
      this.finishTimer = null;
      if (this.destroyed || sequence !== this.sequence) return;
      this.settledSequence = sequence;
      this.onChange('');
      this.onSettled?.(sequence);
    }, delayMs);
    return true;
  }

  currentSequence() {
    return this.sequence;
  }

  isActive() {
    return !this.destroyed
      && this.sequence > 0
      && this.settledSequence !== this.sequence;
  }

  destroy() {
    this.destroyed = true;
    this.sequence += 1;
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

  const commitOnce = (reason: string) => {
    if (finished) return;
    const actualResolution = readActualResolution();
    if (actualResolution && actualResolution !== resolution) {
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
    const result = setResolution.call(activeChart, resolution, { dataReady: () => commitOnce('dataReady') });
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
