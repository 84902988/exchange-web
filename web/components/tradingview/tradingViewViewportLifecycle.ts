export type TradingViewViewportRange = {
  from: number;
  to?: number;
};

export type TradingViewViewportChart = {
  dataReady?: () => Promise<boolean> | boolean;
  setVisibleRange?: (
    range: TradingViewViewportRange,
    options?: {
      applyDefaultRightMargin?: boolean;
      percentRightMargin?: number;
      rejectByTimeout?: number;
    },
  ) => Promise<void> | void;
  getVisibleRange?: () => TradingViewViewportRange;
  getTimeScale?: () => {
    setRightOffset?: (offset: number) => void;
  };
};

export type TradingViewViewportApplyResult = {
  applied: boolean;
  attempts: number;
  reason: 'applied' | 'data-not-ready' | 'stale' | 'apply-failed' | 'verify-failed';
  visibleRange: TradingViewViewportRange | null;
};

type ApplyTradingViewViewportOptions = {
  chart: TradingViewViewportChart;
  range: TradingViewViewportRange;
  fallbackRange: TradingViewViewportRange;
  intervalSeconds: number;
  rightPaddingBars: number;
  isCurrent: () => boolean;
  maxRetries?: number;
  afterApply?: () => Promise<void>;
};

function isFiniteRange(range: TradingViewViewportRange | null | undefined) {
  return Boolean(
    range
    && Number.isFinite(range.from)
    && Number.isFinite(range.to)
    && Number(range.to) > range.from,
  );
}

export function isTradingViewViewportAligned({
  actual,
  target,
  intervalSeconds,
  rightPaddingBars,
}: {
  actual: TradingViewViewportRange | null | undefined;
  target: TradingViewViewportRange;
  intervalSeconds: number;
  rightPaddingBars: number;
}) {
  if (!isFiniteRange(actual) || !isFiniteRange(target)) return false;
  const actualTo = Number(actual?.to);
  const targetTo = Number(target.to);
  const step = Math.max(1, Math.floor(Number(intervalSeconds) || 1));
  const tolerance = step * 2;
  const allowedRightPadding = step * (Math.max(0, Math.floor(rightPaddingBars)) + 2);
  const targetSpan = targetTo - target.from;
  const actualSpan = actualTo - Number(actual?.from);

  return (
    Number(actual?.from) >= target.from - tolerance
    && Number(actual?.from) <= targetTo
    && actualTo >= targetTo - tolerance
    && actualTo <= targetTo + allowedRightPadding
    && actualSpan <= targetSpan + allowedRightPadding + tolerance
  );
}

function waitForViewportPaint() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function readVisibleRange(chart: TradingViewViewportChart) {
  try {
    return chart.getVisibleRange?.() ?? null;
  } catch {
    return null;
  }
}

export async function applyTradingViewViewport({
  chart,
  range,
  fallbackRange,
  intervalSeconds,
  rightPaddingBars,
  isCurrent,
  maxRetries = 1,
  afterApply = waitForViewportPaint,
}: ApplyTradingViewViewportOptions): Promise<TradingViewViewportApplyResult> {
  const maximumAttempts = Math.max(1, Math.floor(maxRetries) + 1);
  let lastReason: TradingViewViewportApplyResult['reason'] = 'apply-failed';
  let lastVisibleRange: TradingViewViewportRange | null = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (!isCurrent()) {
      return { applied: false, attempts: attempt - 1, reason: 'stale', visibleRange: null };
    }

    try {
      if (typeof chart.dataReady !== 'function') {
        lastReason = 'data-not-ready';
        continue;
      }
      const ready = await chart.dataReady();
      if (!ready) {
        lastReason = 'data-not-ready';
        continue;
      }
      if (!isCurrent()) {
        return { applied: false, attempts: attempt, reason: 'stale', visibleRange: null };
      }
      if (typeof chart.setVisibleRange !== 'function') {
        lastReason = 'apply-failed';
        continue;
      }

      const timeScale = chart.getTimeScale?.();
      const canSetRightOffset = typeof timeScale?.setRightOffset === 'function';
      if (canSetRightOffset) timeScale.setRightOffset?.(rightPaddingBars);
      const requestedRange = canSetRightOffset ? range : fallbackRange;
      await chart.setVisibleRange(requestedRange, {
        applyDefaultRightMargin: false,
        percentRightMargin: 0,
        rejectByTimeout: 1_500,
      });
      if (!isCurrent()) {
        return { applied: false, attempts: attempt, reason: 'stale', visibleRange: null };
      }
      if (canSetRightOffset) timeScale.setRightOffset?.(rightPaddingBars);
      await afterApply();
      if (!isCurrent()) {
        return { applied: false, attempts: attempt, reason: 'stale', visibleRange: null };
      }

      lastVisibleRange = readVisibleRange(chart);
      if (isTradingViewViewportAligned({
        actual: lastVisibleRange,
        target: range,
        intervalSeconds,
        rightPaddingBars,
      })) {
        return {
          applied: true,
          attempts: attempt,
          reason: 'applied',
          visibleRange: lastVisibleRange,
        };
      }
      lastReason = 'verify-failed';
    } catch {
      lastReason = 'apply-failed';
    }
  }

  return {
    applied: false,
    attempts: maximumAttempts,
    reason: lastReason,
    visibleRange: lastVisibleRange,
  };
}
