import type {
  AdvancedChartIndicators,
  AdvancedChartOverlayIndicator,
  AdvancedChartPaneIndicator,
} from './advancedChartUrl';

export const ADVANCED_CHART_OVERLAY_INDICATORS = [
  'MA',
  'EMA',
  'BOLL',
  'SAR',
  'AVL',
  'SUPER',
] as const satisfies readonly AdvancedChartOverlayIndicator[];

export const ADVANCED_CHART_PANE_INDICATORS = [
  'VOL',
  'MACD',
  'RSI',
  'KDJ',
  'OBV',
  'WR',
  'StochRSI',
] as const satisfies readonly AdvancedChartPaneIndicator[];

export const ADVANCED_CHART_INDICATORS = [
  ...ADVANCED_CHART_OVERLAY_INDICATORS,
  ...ADVANCED_CHART_PANE_INDICATORS,
] as const;

export type AdvancedChartIndicator =
  | AdvancedChartOverlayIndicator
  | AdvancedChartPaneIndicator;

export type {AdvancedChartIndicators};
