import React, {useEffect, useMemo, useRef, useState} from 'react';
import {PanResponder, Pressable, StyleSheet, Text, View} from 'react-native';
import Svg, {
  G,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';
import type {SpotKline} from '../../api/spot';
import {colors, typography} from '../../theme';
import {
  buildChartScales,
  buildTimeTicks,
  calculateMA,
  formatPrice,
  klineIntervals,
  normalizeKlineData,
  type KlineInterval,
} from './kline.utils';

type Props = {
  items: SpotKline[];
  height?: number;
  visibleCount?: number;
  interval: KlineInterval;
  loading?: boolean;
  error?: string | null;
  pricePrecision?: number;
  showControls?: boolean;
  onIntervalChange?: (interval: KlineInterval) => void;
};

const CHART_WIDTH = 320;
const DEFAULT_VISIBLE_COUNT = 42;
const MA5_COLOR = colors.gold;
const MA10_COLOR = '#FF6FAE';
const MA20_COLOR = '#9B7CFF';

function MobileKlineChart({
  items,
  height = 172,
  visibleCount: preferredVisibleCount = DEFAULT_VISIBLE_COUNT,
  interval,
  loading = false,
  error = null,
  pricePrecision = 2,
  showControls = true,
  onIntervalChange,
}: Props) {
  const chartData = useMemo(() => normalizeKlineData(items).slice(-80), [items]);
  const ma5 = useMemo(() => calculateMA(chartData, 5), [chartData]);
  const ma10 = useMemo(() => calculateMA(chartData, 10), [chartData]);
  const ma20 = useMemo(() => calculateMA(chartData, 20), [chartData]);
  const visibleCount = Math.min(chartData.length, preferredVisibleCount);
  const maxStartIndex = Math.max(chartData.length - visibleCount, 0);
  const [visibleStartIndex, setVisibleStartIndex] = useState(maxStartIndex);
  const dragStartIndexRef = useRef(maxStartIndex);
  const lastDragIndexRef = useRef(maxStartIndex);
  const effectiveStartIndex = clampIndex(visibleStartIndex, 0, maxStartIndex);
  const visibleCandles = useMemo(
    () => chartData.slice(effectiveStartIndex, effectiveStartIndex + visibleCount),
    [chartData, effectiveStartIndex, visibleCount],
  );
  const visibleMa5 = useMemo(
    () => ma5.slice(effectiveStartIndex, effectiveStartIndex + visibleCount),
    [effectiveStartIndex, ma5, visibleCount],
  );
  const visibleMa10 = useMemo(
    () => ma10.slice(effectiveStartIndex, effectiveStartIndex + visibleCount),
    [effectiveStartIndex, ma10, visibleCount],
  );
  const visibleMa20 = useMemo(
    () => ma20.slice(effectiveStartIndex, effectiveStartIndex + visibleCount),
    [effectiveStartIndex, ma20, visibleCount],
  );
  const latest = visibleCandles[visibleCandles.length - 1] ?? null;
  const maValues = useMemo(
    () =>
      [...visibleMa5, ...visibleMa10, ...visibleMa20].filter(
        (value): value is number => value !== null && Number.isFinite(value),
      ),
    [visibleMa5, visibleMa10, visibleMa20],
  );
  const scales = useMemo(
    () =>
      buildChartScales({
        data: visibleCandles,
        width: CHART_WIDTH,
        height,
        priceValues: maValues,
      }),
    [height, maValues, visibleCandles],
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
          key: `${item.time}-${index}`,
          color: up ? colors.green : colors.red,
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
  const maPaths = useMemo(
    () => ({
      ma5: buildMaPath(visibleMa5, scales),
      ma10: buildMaPath(visibleMa10, scales),
      ma20: buildMaPath(visibleMa20, scales),
    }),
    [scales, visibleMa5, visibleMa10, visibleMa20],
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
          const candleStep = Math.max(scales.plotWidth / Math.max(visibleCount - 1, 1), 1);
          const indexShift = Math.trunc(gestureState.dx / candleStep);
          if (indexShift === 0) return;
          const nextIndex = clampIndex(
            dragStartIndexRef.current - indexShift,
            0,
            maxStartIndex,
          );
          if (nextIndex === lastDragIndexRef.current) return;
          lastDragIndexRef.current = nextIndex;
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
    [effectiveStartIndex, maxStartIndex, scales.plotWidth, visibleCount],
  );

  useEffect(() => {
    setVisibleStartIndex(maxStartIndex);
    dragStartIndexRef.current = maxStartIndex;
    lastDragIndexRef.current = maxStartIndex;
  }, [interval, maxStartIndex]);

  const statusText = loading
    ? 'K线加载中'
    : error
      ? 'K线加载失败'
        : chartData.length === 0
        ? '暂无K线数据'
        : chartData.length < 2
          ? '数据不足，仅展示可用K线'
          : null;

  return (
    <View style={styles.wrap}>
      {showControls ? (
        <View style={styles.intervalRow}>
          {klineIntervals.map(item => {
            const active = item === interval;
            return (
              <Pressable
                key={item}
                style={styles.intervalButton}
                onPress={() => onIntervalChange?.(item)}>
                <Text
                  style={[
                    styles.intervalText,
                    active ? styles.intervalTextActive : null,
                  ]}>
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
        <Text style={[styles.maText, {color: MA5_COLOR}]}>
          MA(5): {formatPrice(lastValue(visibleMa5), pricePrecision)}
        </Text>
        <Text style={[styles.maText, {color: MA10_COLOR}]}>
          MA(10): {formatPrice(lastValue(visibleMa10), pricePrecision)}
        </Text>
        <Text style={[styles.maText, {color: MA20_COLOR}]}>
          MA(20): {formatPrice(lastValue(visibleMa20), pricePrecision)}
        </Text>
      </View>

      <View style={[styles.chartBox, {height}]} {...panResponder.panHandlers}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${CHART_WIDTH} ${height}`}>
          <Rect
            fill={colors.bgElevated}
            height={height}
            rx="8"
            ry="8"
            width={CHART_WIDTH}
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
                  y={y + 3}>
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
                y2={scales.bottom}
              />
            );
          })}
          {candleShapes.map(item => {
            return (
              <G key={item.key}>
                <Line
                  stroke={item.color}
                  strokeLinecap="round"
                  strokeWidth="1"
                  x1={item.x}
                  x2={item.x}
                  y1={item.highY}
                  y2={item.lowY}
                />
                <Rect
                  fill={item.color}
                  height={item.bodyHeight}
                  rx="0.8"
                  width={item.bodyWidth}
                  x={item.bodyX}
                  y={item.bodyY}
                />
              </G>
            );
          })}
          <Path d={maPaths.ma5} fill="none" stroke={MA5_COLOR} strokeWidth="1.1" />
          <Path d={maPaths.ma10} fill="none" stroke={MA10_COLOR} strokeWidth="1" />
          <Path d={maPaths.ma20} fill="none" stroke={MA20_COLOR} strokeWidth="1" />
          {latest ? (
            <LatestPriceLabel
              price={latest.close}
              pricePrecision={pricePrecision}
              scales={scales}
            />
          ) : null}
          {timeTicks.map(tick => (
            <SvgText
              key={`time-${tick.index}`}
              fill={colors.textSubtle}
              fontSize="9"
              textAnchor={tick.index === 0 ? 'start' : 'middle'}
              x={scales.xForIndex(tick.index)}
              y={height - 6}>
              {tick.label}
            </SvgText>
          ))}
        </Svg>
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

function LatestPriceLabel({
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
    <G>
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
        textAnchor="middle"
        x={scales.right + 3 + labelWidth / 2}
        y={y + 3}>
        {formatPrice(price, pricePrecision)}
      </SvgText>
    </G>
  );
}

function buildMaPath(values: Array<number | null>, scales: ScaleLike) {
  let path = '';
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) return;
    const x = scales.xForIndex(index);
    const y = scales.yForPrice(value);
    path += path ? ` L ${x} ${y}` : `M ${x} ${y}`;
  });
  return path;
}

function lastValue(values: Array<number | null>) {
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
});
