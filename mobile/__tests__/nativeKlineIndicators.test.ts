import {
  defaultConfigForSelection,
} from '../src/components/chart/advancedChartConfig';
import type {
  AdvancedChartOverlayIndicator,
  AdvancedChartPaneIndicator,
} from '../src/components/chart/advancedChartUrl';
import {
  calculateNativeKlineIndicators,
  ema,
  rsi,
  sma,
} from '../src/components/trade/nativeKlineIndicators';
import type {NormalizedKline} from '../src/components/trade/kline.utils';

const OVERLAYS: readonly AdvancedChartOverlayIndicator[] = [
  'MA',
  'EMA',
  'BOLL',
  'SAR',
  'AVL',
  'SUPER',
];

const PANES: readonly AdvancedChartPaneIndicator[] = [
  'VOL',
  'MACD',
  'RSI',
  'KDJ',
  'OBV',
  'WR',
  'StochRSI',
];

function makeCandles(count = 90): NormalizedKline[] {
  return Array.from({length: count}, (_, index) => {
    const close = 100 + index * 0.4 + Math.sin(index / 3) * 1.5;
    return {
      time: 1_800_000_000_000 + index * 60_000,
      open: close - Math.cos(index / 4) * 0.4,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 1_000 + index * 15,
    };
  });
}

function expectFiniteOutput(values: ReadonlyArray<number | null>) {
  expect(values).toHaveLength(90);
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  expect(finite.length).toBeGreaterThan(0);
}

describe('native Kline indicators', () => {
  it('calculates deterministic SMA, EMA and RSI seeds', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(rsi([1, 2, 3, 4, 5, 6], 3)).toEqual([
      null,
      null,
      null,
      100,
      100,
      100,
    ]);
  });

  it.each(OVERLAYS)('renders finite %s overlay output', overlay => {
    const result = calculateNativeKlineIndicators(
      makeCandles(),
      defaultConfigForSelection({overlay, pane: 'VOL'}),
    );
    expect(result.overlayKind).toBe(overlay);
    expect(result.overlayLines.length).toBeGreaterThan(0);
    result.overlayLines.forEach(item => {
      expectFiniteOutput(item.values);
    });
  });

  it.each(PANES)('renders finite %s pane output', pane => {
    const result = calculateNativeKlineIndicators(
      makeCandles(),
      defaultConfigForSelection({overlay: 'MA', pane}),
    );
    expect(result.paneKind).toBe(pane);
    expect(result.paneLines.length + (result.paneHistogram ? 1 : 0)).toBeGreaterThan(0);
    result.paneLines.forEach(item => {
      expectFiniteOutput(item.values);
    });
    if (result.paneHistogram) {
      expectFiniteOutput(result.paneHistogram.values);
    }
  });

  it('keeps bounded oscillators within their expected domains', () => {
    const candles = makeCandles();
    for (const pane of ['RSI', 'WR', 'StochRSI'] as const) {
      const result = calculateNativeKlineIndicators(
        candles,
        defaultConfigForSelection({overlay: 'MA', pane}),
      );
      for (const indicator of result.paneLines) {
        for (const value of indicator.values) {
          if (value === null) continue;
          expect(value).toBeGreaterThanOrEqual(pane === 'WR' ? -100 : 0);
          expect(value).toBeLessThanOrEqual(pane === 'WR' ? 0 : 100);
        }
      }
    }
  });

  it.each([
    {
      overlay: 'SAR' as const,
      params: {start: 0.04, increment: 0.03, maximum: 0.3},
    },
    {overlay: 'AVL' as const, params: {length: 12}},
    {overlay: 'SUPER' as const, params: {length: 6, multiplier: 2}},
  ])('applies custom $overlay overlay parameters', entry => {
    const candles = makeCandles();
    const defaultConfig = defaultConfigForSelection({
      overlay: entry.overlay,
      pane: 'VOL',
    });
    const customized = {
      ...defaultConfig,
      overlay: {kind: entry.overlay, params: entry.params},
    } as typeof defaultConfig;
    const original = calculateNativeKlineIndicators(candles, defaultConfig);
    const changed = calculateNativeKlineIndicators(candles, customized);
    expect(changed.overlayLines).not.toEqual(original.overlayLines);
  });

  it.each([
    {
      pane: 'KDJ' as const,
      params: {length: 5, kSmoothing: 2, dSmoothing: 4},
    },
    {pane: 'WR' as const, params: {length: 5}},
    {
      pane: 'StochRSI' as const,
      params: {
        rsiLength: 7,
        stochasticLength: 9,
        kSmoothing: 2,
        dSmoothing: 4,
      },
    },
  ])('applies custom $pane pane parameters', entry => {
    const candles = makeCandles();
    const defaultConfig = defaultConfigForSelection({
      overlay: 'MA',
      pane: entry.pane,
    });
    const customized = {
      ...defaultConfig,
      pane: {kind: entry.pane, params: entry.params},
    } as typeof defaultConfig;
    const original = calculateNativeKlineIndicators(candles, defaultConfig);
    const changed = calculateNativeKlineIndicators(candles, customized);
    expect(changed.paneLines).not.toEqual(original.paneLines);
  });

  it('adds and removes the optional OBV moving average without changing raw OBV', () => {
    const candles = makeCandles();
    const defaultConfig = defaultConfigForSelection({overlay: 'MA', pane: 'OBV'});
    const withAverage = calculateNativeKlineIndicators(candles, {
      ...defaultConfig,
      pane: {kind: 'OBV', params: {maLength: 10}},
    });
    const raw = calculateNativeKlineIndicators(candles, defaultConfig);
    expect(raw.paneLines).toHaveLength(1);
    expect(withAverage.paneLines).toHaveLength(2);
    expect(withAverage.paneLines[0]).toEqual(raw.paneLines[0]);
  });
});
