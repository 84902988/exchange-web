import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import { formatUtcTimeLabel } from './chart.utils';
import {
  SPOT_CHART_BG,
  SPOT_CHART_BORDER,
  SPOT_CHART_DEFAULT_LOCALE,
  SPOT_CHART_DOWN,
  SPOT_CHART_GRID,
  SPOT_CHART_MA10,
  SPOT_CHART_MA30,
  SPOT_CHART_MA5,
  SPOT_CHART_MAIN_PANE_STRETCH_FACTOR,
  SPOT_CHART_PANE_SEPARATOR,
  SPOT_CHART_PANE_SEPARATOR_HOVER,
  SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS,
  SPOT_CHART_TEXT,
  SPOT_CHART_TIME_SCALE,
  SPOT_CHART_UP,
  SPOT_CHART_VOLUME_PANE_STRETCH_FACTOR,
} from './chart.constants';

export interface SpotChartSeriesRefs {
  candleSeries: ISeriesApi<'Candlestick'>;
  volumeSeries: ISeriesApi<'Histogram'>;
  ma5Series: ISeriesApi<'Line'>;
  ma10Series: ISeriesApi<'Line'>;
  ma30Series: ISeriesApi<'Line'>;
  volumeMa5Series: ISeriesApi<'Line'>;
  volumeMa10Series: ISeriesApi<'Line'>;
}

export interface CreateSpotChartResult extends SpotChartSeriesRefs {
  chart: IChartApi;
}

export function createSpotChartInstance(
  container: HTMLDivElement,
  height: number,
  pricePrecision: number
): CreateSpotChartResult {
  const priceFormat = {
    type: 'price' as const,
    precision: pricePrecision,
    minMove: 1 / Math.pow(10, pricePrecision),
  };
  const volumePriceFormat = {
    type: 'volume' as const,
    precision: 0,
    minMove: 1,
  };

  const chart = createChart(container, {
    width: container.clientWidth,
    height,
    layout: {
      background: { type: ColorType.Solid, color: SPOT_CHART_BG },
      textColor: SPOT_CHART_TEXT,
      panes: {
        separatorColor: SPOT_CHART_PANE_SEPARATOR,
        separatorHoverColor: SPOT_CHART_PANE_SEPARATOR_HOVER,
      },
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: SPOT_CHART_GRID },
      horzLines: { color: SPOT_CHART_GRID },
    },
    rightPriceScale: {
      autoScale: true,
      borderVisible: false,
      borderColor: SPOT_CHART_BORDER,
      scaleMargins: SPOT_CHART_RIGHT_PRICE_SCALE_MARGINS,
    },
    timeScale: {
      borderColor: SPOT_CHART_BORDER,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: SPOT_CHART_TIME_SCALE.rightOffset,
      barSpacing: SPOT_CHART_TIME_SCALE.barSpacing,
      minBarSpacing: SPOT_CHART_TIME_SCALE.minBarSpacing,
      fixLeftEdge: SPOT_CHART_TIME_SCALE.fixLeftEdge,
      fixRightEdge: SPOT_CHART_TIME_SCALE.fixRightEdge,
      rightBarStaysOnScroll: SPOT_CHART_TIME_SCALE.rightBarStaysOnScroll,
      lockVisibleTimeRangeOnResize:
        SPOT_CHART_TIME_SCALE.lockVisibleTimeRangeOnResize,
      shiftVisibleRangeOnNewBar: SPOT_CHART_TIME_SCALE.shiftVisibleRangeOnNewBar,
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        visible: true,
        labelVisible: true,
        labelBackgroundColor: '#111827',
        color: 'rgba(255,255,255,0.15)',
        width: 1,
        style: LineStyle.Dashed,
      },
      horzLine: {
        visible: true,
        labelVisible: true,
        labelBackgroundColor: '#111827',
        color: 'rgba(255,255,255,0.15)',
        width: 1,
        style: LineStyle.Dashed,
      },
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
    localization: {
      locale: SPOT_CHART_DEFAULT_LOCALE,
      timeFormatter: (time: number) => formatUtcTimeLabel(time),
    },
  });

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: SPOT_CHART_UP,
    downColor: SPOT_CHART_DOWN,
    borderUpColor: SPOT_CHART_UP,
    borderDownColor: SPOT_CHART_DOWN,
    wickUpColor: SPOT_CHART_UP,
    wickDownColor: SPOT_CHART_DOWN,
    borderVisible: true,
    wickVisible: true,
    priceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  const ma5Series = chart.addSeries(LineSeries, {
    color: SPOT_CHART_MA5,
    lineWidth: 1,
    priceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  const ma10Series = chart.addSeries(LineSeries, {
    color: SPOT_CHART_MA10,
    lineWidth: 1,
    priceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  const ma30Series = chart.addSeries(LineSeries, {
    color: SPOT_CHART_MA30,
    lineWidth: 1,
    priceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  const volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: volumePriceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
  }, 1);

  const volumeMa5Series = chart.addSeries(LineSeries, {
    color: SPOT_CHART_MA5,
    lineWidth: 1,
    priceFormat: volumePriceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  }, 1);

  const volumeMa10Series = chart.addSeries(LineSeries, {
    color: SPOT_CHART_MA10,
    lineWidth: 1,
    priceFormat: volumePriceFormat,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  }, 1);

  const panes = chart.panes();
  panes[0]?.setStretchFactor(SPOT_CHART_MAIN_PANE_STRETCH_FACTOR);
  panes[1]?.setStretchFactor(SPOT_CHART_VOLUME_PANE_STRETCH_FACTOR);

  return {
    chart,
    candleSeries,
    volumeSeries,
    ma5Series,
    ma10Series,
    ma30Series,
    volumeMa5Series,
    volumeMa10Series,
  };
}

export function resizeSpotChart(
  chart: IChartApi | null,
  container: HTMLDivElement | null
) {
  if (!chart || !container) return;

  chart.applyOptions({
    width: container.clientWidth,
  });
}
