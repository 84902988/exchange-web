import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import type { SpotKline } from '../../api/spot';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import type {AdvancedChartIndicatorConfigV2} from '../chart/advancedChartConfig';
import {
  buildChartScales,
  buildCandlePathBuckets,
  buildTimeTicks,
  calculateMA,
  formatPrice,
  klineIntervals,
  normalizeKlineData,
  reconcileKlineVisibleStartIndex,
  resolveAdaptiveKlineVisibleCount,
  resolveKlineDragIndex,
  type KlineInterval,
} from './kline.utils';
import {
  calculateNativeKlineIndicators,
  type NativeIndicatorLine,
  type NativePaneHistogram,
} from './nativeKlineIndicators';

export type KlineReferencePriceLineKind =
  | 'ENTRY'
  | 'TAKE_PROFIT'
  | 'STOP_LOSS';

export type KlineReferencePriceLine = {
  key: string;
  kind: KlineReferencePriceLineKind;
  label: string;
  price: number;
};

type Props = {
  items: SpotKline[];
  currentPrice?: number | null;
  height?: number;
  visibleCount?: number;
  interval: KlineInterval;
  loading?: boolean;
  error?: string | null;
  statusNote?: string | null;
  pricePrecision?: number;
  showControls?: boolean;
  showPane?: boolean;
  indicatorConfig?: AdvancedChartIndicatorConfigV2;
  referencePriceLines?: readonly KlineReferencePriceLine[];
  testID?: string;
  onIntervalChange?: (interval: KlineInterval) => void;
};

const INITIAL_CHART_WIDTH = 320;
const DEFAULT_VISIBLE_COUNT = 42;
const MA5_COLOR = colors.gold;
const MA10_COLOR = '#FF6FAE';
const MA20_COLOR = '#9B7CFF';
const INDICATOR_COLORS = [MA5_COLOR, '#2FA8FF', MA10_COLOR, MA20_COLOR] as const;
const MAX_INDICATOR_HISTORY = 600;

function MobileKlineChart({
  items,
  currentPrice = null,
  height = 172,
  visibleCount: preferredVisibleCount = DEFAULT_VISIBLE_COUNT,
  interval,
  loading = false,
  error = null,
  statusNote = null,
  pricePrecision = 2,
  showControls = true,
  showPane = true,
  indicatorConfig,
  referencePriceLines = [],
  testID,
  onIntervalChange,
}: Props) {
  const { t } = useLanguage();
  const [chartWidth, setChartWidth] = useState(INITIAL_CHART_WIDTH);
  const chartData = useMemo(
    () => normalizeKlineData(items).slice(-MAX_INDICATOR_HISTORY),
    [items],
  );
  const ma5 = useMemo(() => calculateMA(chartData, 5), [chartData]);
  const ma10 = useMemo(() => calculateMA(chartData, 10), [chartData]);
  const ma20 = useMemo(() => calculateMA(chartData, 20), [chartData]);
  const visibleCount = resolveAdaptiveKlineVisibleCount({
    chartWidth,
    dataLength: chartData.length,
    preferredMaximum: preferredVisibleCount,
  });
  const maxStartIndex = Math.max(chartData.length - visibleCount, 0);
  const [visibleStartIndex, setVisibleStartIndex] = useState(maxStartIndex);
  const dragStartIndexRef = useRef(maxStartIndex);
  const lastDragIndexRef = useRef(maxStartIndex);
  const previousIntervalRef = useRef(interval);
  const previousMaxStartIndexRef = useRef(maxStartIndex);
  const effectiveStartIndex = clampIndex(visibleStartIndex, 0, maxStartIndex);
  const visibleAnchorTimeRef = useRef<number | null>(
    chartData[effectiveStartIndex]?.time ?? null,
  );
  const visibleCandles = useMemo(
    () =>
      chartData.slice(effectiveStartIndex, effectiveStartIndex + visibleCount),
    [chartData, effectiveStartIndex, visibleCount],
  );
  const nativeIndicators = useMemo(
    () =>
      indicatorConfig
        ? calculateNativeKlineIndicators(chartData, indicatorConfig)
        : null,
    [chartData, indicatorConfig],
  );
  const overlayLines = useMemo<readonly NativeIndicatorLine[]>(
    () =>
      nativeIndicators?.overlayLines ?? [
        {key: 'ma5', label: 'MA(5)', values: ma5, render: 'line'},
        {key: 'ma10', label: 'MA(10)', values: ma10, render: 'line'},
        {key: 'ma20', label: 'MA(20)', values: ma20, render: 'line'},
      ],
    [ma10, ma20, ma5, nativeIndicators],
  );
  const visibleOverlayLines = useMemo(
    () =>
      overlayLines.map(item => ({
        ...item,
        values: item.values.slice(
          effectiveStartIndex,
          effectiveStartIndex + visibleCount,
        ),
      })),
    [effectiveStartIndex, overlayLines, visibleCount],
  );
  const visiblePaneLines = useMemo(
    () =>
      showPane
        ? (nativeIndicators?.paneLines ?? []).map(item => ({
            ...item,
            values: item.values.slice(
              effectiveStartIndex,
              effectiveStartIndex + visibleCount,
            ),
          }))
        : [],
    [effectiveStartIndex, nativeIndicators, showPane, visibleCount],
  );
  const visiblePaneHistogram = useMemo(
    () =>
      showPane && nativeIndicators?.paneHistogram
        ? {
            ...nativeIndicators.paneHistogram,
            values: nativeIndicators.paneHistogram.values.slice(
              effectiveStartIndex,
              effectiveStartIndex + visibleCount,
            ),
          }
        : null,
    [effectiveStartIndex, nativeIndicators, showPane, visibleCount],
  );
  const latest = visibleCandles[visibleCandles.length - 1] ?? null;
  const liveCurrentPrice =
    currentPrice !== null &&
    Number.isFinite(currentPrice) &&
    currentPrice > 0
      ? currentPrice
      : null;
  const viewingLatestWindow =
    effectiveStartIndex === maxStartIndex ||
    effectiveStartIndex === previousMaxStartIndexRef.current;
  const currentPriceLinePrice =
    viewingLatestWindow
      ? liveCurrentPrice ?? latest?.close ?? null
      : latest?.close ?? null;
  const validReferencePriceLines = useMemo(
    () =>
      referencePriceLines.filter(
        line =>
          line.key.trim() !== '' &&
          line.label.trim() !== '' &&
          Number.isFinite(line.price) &&
          line.price > 0,
      ),
    [referencePriceLines],
  );
  const overlayValues = useMemo(
    () =>
      visibleOverlayLines.flatMap(item => item.values).filter(
        (value): value is number => value !== null && Number.isFinite(value),
      ),
    [visibleOverlayLines],
  );
  const hasPane = showPane && nativeIndicators !== null;
  const paneTop = hasPane ? Math.round(height * 0.68) : height;
  const paneBottom = height - 20;
  const scales = useMemo(
    () =>
      buildChartScales({
        data: visibleCandles,
        width: chartWidth,
        height: paneTop,
        priceValues: overlayValues,
      }),
    [chartWidth, overlayValues, paneTop, visibleCandles],
  );
  const timeTicks = useMemo(
    () => buildTimeTicks(visibleCandles, interval),
    [interval, visibleCandles],
  );
  const candleShapes = useMemo(
    () =>
      visibleCandles.map((item, index) => {
        const x = scales.xForIndex(index);
        const up = item.close >= item.open;
        const highY = scales.yForPrice(item.high);
        const lowY = scales.yForPrice(item.low);
        const openY = scales.yForPrice(item.open);
        const closeY = scales.yForPrice(item.close);
        return {
          up,
          highY,
          lowY,
          bodyX: x - scales.candleWidth / 2,
          bodyY: Math.min(openY, closeY),
          bodyHeight: Math.max(Math.abs(openY - closeY), 1),
          bodyWidth: scales.candleWidth,
          x,
        };
      }),
    [scales, visibleCandles],
  );
  const candlePaths = useMemo(
    () => buildCandlePathBuckets(candleShapes),
    [candleShapes],
  );
  const overlayPaths = useMemo(
    () =>
      visibleOverlayLines.map(item => ({
        ...item,
        path: buildSeriesPath(item.values, value => scales.yForPrice(value), scales),
      })),
    [scales, visibleOverlayLines],
  );
  const paneScale = useMemo(
    () =>
      hasPane && nativeIndicators
        ? buildPaneScale({
            bottom: paneBottom,
            fixedRange: nativeIndicators.paneFixedRange,
            guides: nativeIndicators.paneGuides,
            histogram: visiblePaneHistogram?.values ?? [],
            lines: visiblePaneLines,
            top: paneTop,
          })
        : null,
    [
      hasPane,
      nativeIndicators,
      paneBottom,
      paneTop,
      visiblePaneHistogram,
      visiblePaneLines,
    ],
  );
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) => {
          const absDx = Math.abs(gestureState.dx);
          const absDy = Math.abs(gestureState.dy);
          return absDx > 8 && absDx > absDy * 1.25;
        },
        onPanResponderGrant: () => {
          dragStartIndexRef.current = effectiveStartIndex;
          lastDragIndexRef.current = effectiveStartIndex;
        },
        onPanResponderMove: (_, gestureState) => {
          if (visibleCount <= 1 || maxStartIndex <= 0) return;
          const candleStep = Math.max(
            scales.plotWidth / Math.max(visibleCount - 1, 1),
            1,
          );
          const nextIndex = resolveKlineDragIndex({
            candleStep,
            deltaX: gestureState.dx,
            dragStartIndex: dragStartIndexRef.current,
            maximumStartIndex: maxStartIndex,
          });
          if (nextIndex === lastDragIndexRef.current) return;
          lastDragIndexRef.current = nextIndex;
          visibleAnchorTimeRef.current = chartData[nextIndex]?.time ?? null;
          setVisibleStartIndex(nextIndex);
        },
        onPanResponderRelease: () => {
          dragStartIndexRef.current = lastDragIndexRef.current;
        },
        onPanResponderTerminate: () => {
          dragStartIndexRef.current = lastDragIndexRef.current;
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [
      chartData,
      effectiveStartIndex,
      maxStartIndex,
      scales.plotWidth,
      visibleCount,
    ],
  );

  useEffect(() => {
    const intervalChanged = previousIntervalRef.current !== interval;
    const previousMaxStartIndex = previousMaxStartIndexRef.current;
    setVisibleStartIndex(current => {
      const next = reconcileKlineVisibleStartIndex({
        current,
        previousMax: previousMaxStartIndex,
        nextMax: maxStartIndex,
        intervalChanged,
        previousAnchorTime: visibleAnchorTimeRef.current,
        nextOpenTimes: chartData.map(item => item.time),
      });
      dragStartIndexRef.current = next;
      lastDragIndexRef.current = next;
      visibleAnchorTimeRef.current = chartData[next]?.time ?? null;
      return next;
    });
    previousIntervalRef.current = interval;
    previousMaxStartIndexRef.current = maxStartIndex;
  }, [chartData, interval, maxStartIndex]);

  const handleChartLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.max(1, event.nativeEvent.layout.width);
    setChartWidth(current =>
      Math.abs(current - nextWidth) < 0.5 ? current : nextWidth,
    );
  }, []);

  const statusText = loading
    ? t('kline.loading')
    : error
    ? t('kline.failed')
    : chartData.length === 0
    ? t('kline.empty')
    : chartData.length < 2
    ? t('kline.partial')
    : null;

  return (
    <View style={styles.wrap} testID={testID}>
      {showControls ? (
        <View style={styles.intervalRow}>
          {klineIntervals.map(item => {
            const active = item === interval;
            return (
              <Pressable
                accessibilityLabel={t('kline.intervalA11y', { interval: item })}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                disabled={active}
                hitSlop={{ top: 7, bottom: 7 }}
                key={item}
                style={({ pressed }) => [
                  styles.intervalButton,
                  pressed ? styles.intervalPressed : null,
                ]}
                onPress={() => {
                  if (!active) onIntervalChange?.(item);
                }}
              >
                <Text
                  style={[
                    styles.intervalText,
                    active ? styles.intervalTextActive : null,
                  ]}
                >
                  {item}
                </Text>
                <View
                  style={[
                    styles.intervalIndicator,
                    active ? styles.intervalIndicatorActive : null,
                  ]}
                />
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={styles.maRow}>
        {visibleOverlayLines.map((item, index) => (
          <Text
            key={item.key}
            style={[
              styles.maText,
              {color: INDICATOR_COLORS[index % INDICATOR_COLORS.length]},
            ]}
          >
            {item.label}: {formatPrice(lastValue(item.values), pricePrecision)}
          </Text>
        ))}
      </View>
      <View
        style={[styles.chartBox, {height}]}
        testID={testID ? `${testID}-canvas` : undefined}
        onLayout={handleChartLayout}
        {...panResponder.panHandlers}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${chartWidth} ${height}`}
        >
          <Rect
            fill={colors.bgElevated}
            height={height}
            rx="8"
            ry="8"
            width={chartWidth}
            x="0"
            y="0"
          />
          {scales.priceTicks.map((tick, index) => {
            const y = scales.yForPrice(tick);
            return (
              <G key={`grid-${index}`}>
                <Line
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth="0.7"
                  x1={scales.left}
                  x2={scales.right}
                  y1={y}
                  y2={y}
                />
                <SvgText
                  fill={colors.textSubtle}
                  fontSize="9"
                  textAnchor="start"
                  x={scales.right + 6}
                  y={y + 3}
                >
                  {formatPrice(tick, pricePrecision)}
                </SvgText>
              </G>
            );
          })}
          {[0.25, 0.5, 0.75].map(ratio => {
            const x = scales.left + scales.plotWidth * ratio;
            return (
              <Line
                key={`v-${ratio}`}
                stroke="rgba(255,255,255,0.035)"
                strokeWidth="0.7"
                x1={x}
                x2={x}
                y1={scales.top}
                y2={hasPane ? paneBottom : scales.bottom}
              />
            );
          })}
          {candlePaths.upWicks ? (
            <Path
              d={candlePaths.upWicks}
              fill="none"
              stroke={colors.green}
              strokeLinecap="round"
              strokeWidth="1"
            />
          ) : null}
          {candlePaths.downWicks ? (
            <Path
              d={candlePaths.downWicks}
              fill="none"
              stroke={colors.red}
              strokeLinecap="round"
              strokeWidth="1"
            />
          ) : null}
          {candlePaths.upBodies ? (
            <Path d={candlePaths.upBodies} fill={colors.green} />
          ) : null}
          {candlePaths.downBodies ? (
            <Path d={candlePaths.downBodies} fill={colors.red} />
          ) : null}
          {overlayPaths.map((item, lineIndex) =>
            item.render === 'points' ? (
              <G key={item.key}>
                {item.values.map((value, index) =>
                  value === null ? null : (
                    <Circle
                      cx={scales.xForIndex(index)}
                      cy={scales.yForPrice(value)}
                      fill={INDICATOR_COLORS[lineIndex % INDICATOR_COLORS.length]}
                      key={`${item.key}-${index}`}
                      r="1.35"
                    />
                  ),
                )}
              </G>
            ) : (
              <Path
                d={item.path}
                fill="none"
                key={item.key}
                stroke={INDICATOR_COLORS[lineIndex % INDICATOR_COLORS.length]}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={lineIndex === 0 ? '1.1' : '1'}
              />
            ),
          )}
          {validReferencePriceLines.map((line, index) => {
            const edge = referenceLineEdge(line.price, scales);
            const edgeStackIndex = validReferencePriceLines
              .slice(0, index)
              .filter(candidate => referenceLineEdge(candidate.price, scales) === edge)
              .length;
            return (
              <ReferencePriceLine
                edge={edge}
                edgeStackIndex={edge === null ? 0 : edgeStackIndex}
                key={line.key}
                line={line}
                pricePrecision={pricePrecision}
                scales={scales}
              />
            );
          })}
          {currentPriceLinePrice !== null ? (
            <CurrentPriceLabel
              price={currentPriceLinePrice}
              pricePrecision={pricePrecision}
              scales={scales}
            />
          ) : null}
          {hasPane && paneScale && nativeIndicators ? (
            <NativeIndicatorPane
              bottom={paneBottom}
              candles={visibleCandles}
              histogram={visiblePaneHistogram}
              indicatorKind={nativeIndicators.paneKind}
              lines={visiblePaneLines}
              paneScale={paneScale}
              scales={scales}
              top={paneTop}
            />
          ) : null}
          {timeTicks.map(tick => (
            <SvgText
              key={`time-${tick.index}`}
              fill={colors.textSubtle}
              fontSize="9"
              textAnchor={tick.index === 0 ? 'start' : 'middle'}
              x={scales.xForIndex(tick.index)}
              y={height - 6}
            >
              {tick.label}
            </SvgText>
          ))}
        </Svg>
        {statusNote ? (
          <View pointerEvents="none" style={styles.statusNoteOverlay}>
            <Text numberOfLines={1} style={styles.statusNote}>
              {statusNote}
            </Text>
          </View>
        ) : null}
        {statusText ? (
          <View style={styles.statusOverlay}>
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default React.memo(MobileKlineChart);

type ScaleLike = ReturnType<typeof buildChartScales>;

const REFERENCE_LINE_COLORS: Record<KlineReferencePriceLineKind, string> = {
  ENTRY: colors.gold,
  TAKE_PROFIT: colors.green,
  STOP_LOSS: colors.red,
};

type ReferenceLineEdge = 'above' | 'below' | null;

function referenceLineEdge(price: number, scales: ScaleLike): ReferenceLineEdge {
  if (price > scales.maxPrice) return 'above';
  if (price < scales.minPrice) return 'below';
  return null;
}

function ReferencePriceLine({
  edge,
  edgeStackIndex,
  line,
  pricePrecision,
  scales,
}: {
  edge: ReferenceLineEdge;
  edgeStackIndex: number;
  line: KlineReferencePriceLine;
  pricePrecision: number;
  scales: ScaleLike;
}) {
  const color = REFERENCE_LINE_COLORS[line.kind];
  const rawY = scales.yForPrice(line.price);
  const edgeOffset = Math.min(edgeStackIndex, 2) * 15;
  const y =
    edge === 'above'
      ? scales.top + 8 + edgeOffset
      : edge === 'below'
      ? scales.bottom - 8 - edgeOffset
      : Math.max(scales.top + 8, Math.min(scales.bottom - 8, rawY));
  const direction = edge === 'above' ? '↑ ' : edge === 'below' ? '↓ ' : '';
  const text = `${direction}${line.label} ${formatPrice(
    line.price,
    pricePrecision,
  )}`;
  const labelHeight = 14;
  const labelWidth = Math.min(
    Math.max(text.length * 5.2 + 10, 72),
    Math.max(scales.plotWidth * 0.62, 72),
  );
  const labelX = scales.left + 2;

  return (
    <G testID={`kline-reference-line-${line.key}`}>
      <Line
        stroke={color}
        strokeDasharray={line.kind === 'ENTRY' ? '4 3' : '2 2'}
        strokeWidth="0.9"
        x1={scales.left}
        x2={scales.right}
        y1={y}
        y2={y}
      />
      <Rect
        fill={color}
        height={labelHeight}
        opacity="0.92"
        rx="3"
        width={labelWidth}
        x={labelX}
        y={y - labelHeight / 2}
      />
      <SvgText
        fill={colors.black}
        fontSize="7.5"
        fontWeight="700"
        x={labelX + 5}
        y={y + 2.8}
      >
        {text}
      </SvgText>
    </G>
  );
}

function CurrentPriceLabel({
  price,
  pricePrecision,
  scales,
}: {
  price: number;
  pricePrecision: number;
  scales: ScaleLike;
}) {
  const rawY = scales.yForPrice(price);
  const y = Math.max(scales.top + 8, Math.min(scales.bottom - 8, rawY));
  const labelWidth = 48;
  const labelHeight = 16;
  return (
    <G testID="kline-current-price-label">
      <Line
        stroke="rgba(214,168,50,0.42)"
        strokeDasharray="3 3"
        strokeWidth="0.8"
        x1={scales.left}
        x2={scales.right}
        y1={y}
        y2={y}
      />
      <Rect
        fill={colors.gold}
        height={labelHeight}
        rx="4"
        width={labelWidth}
        x={scales.right + 3}
        y={y - labelHeight / 2}
      />
      <SvgText
        fill={colors.black}
        fontSize="8.5"
        fontWeight="700"
        testID="kline-current-price-label-text"
        textAnchor="middle"
        x={scales.right + 3 + labelWidth / 2}
        y={y + 3}
      >
        {formatPrice(price, pricePrecision)}
      </SvgText>
    </G>
  );
}

type PaneScale = Readonly<{
  guides: readonly number[];
  yForValue: (value: number) => number;
}>;

function NativeIndicatorPane({
  bottom,
  candles,
  histogram,
  indicatorKind,
  lines,
  paneScale,
  scales,
  top,
}: {
  bottom: number;
  candles: ReturnType<typeof normalizeKlineData>;
  histogram: NativePaneHistogram | null;
  indicatorKind: AdvancedChartIndicatorConfigV2['pane']['kind'];
  lines: readonly NativeIndicatorLine[];
  paneScale: PaneScale;
  scales: ScaleLike;
  top: number;
}) {
  const baseline = paneScale.yForValue(0);
  const histogramWidth = Math.max(1.5, scales.candleWidth * 0.72);
  return (
    <G testID="native-kline-indicator-pane">
      <Line
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="0.8"
        x1={scales.left}
        x2={scales.right}
        y1={top - 4}
        y2={top - 4}
      />
      {paneScale.guides.map(guide => {
        const y = paneScale.yForValue(guide);
        return (
          <G key={`pane-guide-${guide}`}>
            <Line
              stroke="rgba(255,255,255,0.055)"
              strokeDasharray={guide === 0 ? undefined : '3 3'}
              strokeWidth="0.6"
              x1={scales.left}
              x2={scales.right}
              y1={y}
              y2={y}
            />
            <SvgText
              fill={colors.textSubtle}
              fontSize="7.5"
              textAnchor="start"
              x={scales.right + 6}
              y={Math.max(top + 8, Math.min(bottom, y + 3))}
            >
              {formatIndicatorValue(guide)}
            </SvgText>
          </G>
        );
      })}
      {histogram
        ? histogram.values.map((value, index) => {
            if (value === null || !Number.isFinite(value)) return null;
            const valueY = paneScale.yForValue(value);
            const isPositive = histogram.key === 'volume'
              ? (candles[index]?.close ?? 0) >= (candles[index]?.open ?? 0)
              : value >= 0;
            return (
              <Rect
                fill={isPositive ? colors.green : colors.red}
                height={Math.max(0.8, Math.abs(baseline - valueY))}
                key={`${histogram.key}-${index}`}
                opacity="0.85"
                width={histogramWidth}
                x={scales.xForIndex(index) - histogramWidth / 2}
                y={Math.min(baseline, valueY)}
              />
            );
          })
        : null}
      {lines.map((item, index) => (
        <Path
          d={buildSeriesPath(item.values, paneScale.yForValue, scales)}
          fill="none"
          key={item.key}
          stroke={INDICATOR_COLORS[index % INDICATOR_COLORS.length]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1"
        />
      ))}
      <SvgText
        fill={colors.textMuted}
        fontSize="8"
        fontWeight="700"
        x={scales.left + 2}
        y={top + 8}
      >
        {paneLegend(indicatorKind, lines, histogram)}
      </SvgText>
    </G>
  );
}

export function buildPaneScale({
  bottom,
  fixedRange,
  guides,
  histogram,
  lines,
  top,
}: {
  bottom: number;
  fixedRange: readonly [number, number] | null;
  guides: readonly number[];
  histogram: ReadonlyArray<number | null>;
  lines: readonly NativeIndicatorLine[];
  top: number;
}): PaneScale {
  const values = [...histogram, ...lines.flatMap(item => item.values), ...guides].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const valueMin = values.length ? Math.min(...values) : 0;
  const valueMax = values.length ? Math.max(...values) : 1;
  const rawMin = fixedRange ? Math.min(fixedRange[0], valueMin) : valueMin;
  const rawMax = fixedRange ? Math.max(fixedRange[1], valueMax) : valueMax;
  const range = Math.max(rawMax - rawMin, 0.000001);
  const padding = range * 0.08;
  const minimum = rawMin - padding;
  const maximum = rawMax + padding;
  const plotTop = top + 13;
  const plotBottom = Math.max(plotTop + 1, bottom);
  const plotHeight = plotBottom - plotTop;
  return {
    guides,
    yForValue: value =>
      plotTop + ((maximum - value) / Math.max(maximum - minimum, 0.000001)) * plotHeight,
  };
}

function paneLegend(
  indicatorKind: AdvancedChartIndicatorConfigV2['pane']['kind'],
  lines: readonly NativeIndicatorLine[],
  histogram: NativePaneHistogram | null,
) {
  const values = lines
    .map(item => `${item.label}:${formatIndicatorValue(lastValue(item.values))}`)
    .join('  ');
  const histogramValue = histogram
    ? formatIndicatorValue(lastValue(histogram.values))
    : '';
  return [indicatorKind, histogramValue, values].filter(Boolean).join('  ');
}

function formatIndicatorValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '--';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

function buildSeriesPath(
  values: ReadonlyArray<number | null>,
  yForValue: (value: number) => number,
  scales: ScaleLike,
) {
  let path = '';
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      path += path ? ' ' : '';
      return;
    }
    const x = scales.xForIndex(index);
    const y = yForValue(value);
    const previous = index > 0 ? values[index - 1] : null;
    path += previous === null || !Number.isFinite(previous)
      ? `${path ? ' ' : ''}M ${x} ${y}`
      : ` L ${x} ${y}`;
  });
  return path;
}

function lastValue(values: ReadonlyArray<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function clampIndex(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  intervalRow: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  intervalButton: {
    minWidth: 36,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  intervalPressed: {
    opacity: 0.7,
  },
  intervalText: {
    ...typography.number,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  intervalTextActive: {
    color: colors.gold,
  },
  intervalIndicator: {
    position: 'absolute',
    bottom: 1,
    width: 16,
    height: 2,
    borderRadius: 1,
  },
  intervalIndicatorActive: {
    backgroundColor: colors.gold,
  },
  maRow: {
    minHeight: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  maText: {
    ...typography.number,
    fontSize: 10,
    fontWeight: '800',
  },
  chartBox: {
    position: 'relative',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    overflow: 'hidden',
  },
  statusOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5,5,5,0.18)',
  },
  statusText: {
    ...typography.medium,
    color: colors.textSubtle,
    fontSize: 11,
  },
  statusNote: {
    ...typography.medium,
    color: colors.gold,
    fontSize: 10,
  },
  statusNoteOverlay: {
    position: 'absolute',
    top: 5,
    left: 8,
    right: 58,
    borderRadius: 4,
    backgroundColor: 'rgba(5,5,5,0.72)',
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
});
