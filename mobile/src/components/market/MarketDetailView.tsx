import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  type DimensionValue,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  ArrowLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ContractKline } from '../../api/contract';
import type { SpotKline, SpotOrderBookLevel, SpotTrade } from '../../api/spot';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';
import { formatFixedPrice } from '../../utils/format';
import {
  ADVANCED_CHART_INDICATORS,
  ADVANCED_CHART_OVERLAY_INDICATORS,
  ADVANCED_CHART_PANE_INDICATORS,
  type AdvancedChartIndicator,
  type AdvancedChartIndicators,
} from '../chart/advancedChartIndicators';
import AdvancedChartIndicatorSettingsSheet from '../chart/AdvancedChartIndicatorSettingsSheet';
import type { AdvancedChartCategory } from '../chart/advancedChartUrl';
import { useAdvancedChartPreferences } from '../chart/useAdvancedChartPreferences';
import MobileKlineChart, {
  type KlineReferencePriceLine,
} from '../trade/MobileKlineChart';
import type { KlineInterval } from '../trade/kline.utils';

type DetailTab = 'depth' | 'trades' | 'info';

type HorizontalOverflowMetrics = {
  contentWidth: number;
  offsetX: number;
  viewportWidth: number;
};

export function getHorizontalOverflowPresentation({
  contentWidth,
  offsetX,
  viewportWidth,
}: HorizontalOverflowMetrics) {
  const maximumOffset = Math.max(0, contentWidth - viewportWidth);
  const hasOverflow = maximumOffset > 1;
  return {
    atEnd: !hasOverflow || offsetX >= maximumOffset - 2,
    hasOverflow,
  } as const;
}

export type MarketDetailViewProps = {
  market: 'spot' | 'contract';
  symbol: string;
  symbolLabel: string;
  baseAsset: string;
  quoteAsset: string;
  category?: AdvancedChartCategory;
  price: number | null;
  markPrice?: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  baseVolume24h: number | null;
  quoteVolume24h: number | null;
  displayPricePrecision: number;
  marketStatus?: string | null;
  realtimePhase?: string | null;
  realtimeError?: string | null;
  bids: SpotOrderBookLevel[];
  asks: SpotOrderBookLevel[];
  trades: SpotTrade[];
  interval: KlineInterval;
  fallbackKlines: Array<SpotKline | ContractKline>;
  fallbackLoading?: boolean;
  fallbackError?: string | null;
  fallbackStatusNote?: string | null;
  referencePriceLines?: readonly KlineReferencePriceLine[];
  fullscreen: boolean;
  onBack: () => void;
  onEnterFullscreen: () => void;
  onExitFullscreen: () => void;
  onIntervalChange: (interval: KlineInterval) => void;
};

export default function MarketDetailView({
  market,
  symbol,
  symbolLabel,
  baseAsset,
  quoteAsset,
  category,
  price,
  markPrice = null,
  changePercent,
  high24h,
  low24h,
  baseVolume24h,
  quoteVolume24h,
  displayPricePrecision,
  marketStatus = null,
  realtimePhase = null,
  realtimeError = null,
  bids,
  asks,
  trades,
  interval,
  fallbackKlines,
  fallbackLoading = false,
  fallbackError = null,
  fallbackStatusNote = null,
  referencePriceLines = [],
  fullscreen,
  onBack,
  onEnterFullscreen,
  onExitFullscreen,
  onIntervalChange,
}: MarketDetailViewProps) {
  const { t } = useLanguage();
  const { height } = useWindowDimensions();
  const [activeTab, setActiveTab] = useState<DetailTab>('depth');
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [paneVisible, setPaneVisible] = useState(true);
  const chartPreferences = useAdvancedChartPreferences();
  const activeIndicators = chartPreferences.selection;
  const portraitLayout = resolvePortraitLayout(height);
  const bookRows = Math.max(
    1,
    portraitLayout.bookRows - (realtimeError ? 1 : 0),
  );
  const up = (changePercent ?? 0) >= 0;
  const priceColor = up ? colors.green : colors.red;
  const canEnterFullscreen = true;
  const fallbackChromeHeight = 94;
  const fallbackChartHeight = fullscreen
    ? Math.max(60, height - 42 - fallbackChromeHeight)
    : Math.max(60, portraitLayout.chartHeight - fallbackChromeHeight);
  const visibleBids = useMemo(
    () => bids.filter(isUsableDepthLevel).slice(0, bookRows),
    [bids, bookRows],
  );
  const visibleAsks = useMemo(
    () => asks.filter(isUsableDepthLevel).slice(0, bookRows),
    [asks, bookRows],
  );
  const handleIndicatorChange = (indicator: AdvancedChartIndicator) => {
    const isPaneIndicator = ADVANCED_CHART_PANE_INDICATORS.some(
      candidate => candidate === indicator,
    );
    if (isPaneIndicator) {
      if (activeIndicators.pane === indicator && paneVisible) {
        setPaneVisible(false);
        return;
      }
      setPaneVisible(true);
    }
    chartPreferences.selectNativeIndicator(indicator);
  };

  return (
    <SafeAreaView
      edges={['top', 'right', 'bottom', 'left']}
      style={styles.safe}
      testID={fullscreen ? 'market-detail-landscape' : 'market-detail-portrait'}
    >
      <View style={styles.root}>
        {fullscreen ? (
          <LandscapeHeader
            changePercent={changePercent}
            price={price}
            priceColor={priceColor}
            pricePrecision={displayPricePrecision}
            symbolLabel={symbolLabel}
            onBack={onExitFullscreen}
          />
        ) : (
          <PortraitHeader
            baseAsset={baseAsset}
            market={market}
            symbolLabel={symbolLabel}
            onBack={onBack}
          />
        )}

        {!fullscreen ? (
          <MarketSummary
            baseAsset={baseAsset}
            baseVolume24h={baseVolume24h}
            changePercent={changePercent}
            high24h={high24h}
            low24h={low24h}
            markPrice={market === 'contract' ? markPrice : null}
            price={price}
            priceColor={priceColor}
            pricePrecision={displayPricePrecision}
            quoteAsset={quoteAsset}
            quoteVolume24h={quoteVolume24h}
          />
        ) : null}

        <View
          key="market-detail-chart-shell"
          style={[
            styles.chartShell,
            fullscreen
              ? styles.chartShellFullscreen
              : { height: portraitLayout.chartHeight },
          ]}
          testID="market-detail-chart-shell"
        >
          <IndicatorToolbar
            activeIndicators={activeIndicators}
            canEnterFullscreen={canEnterFullscreen}
            disabled={false}
            fullscreen={fullscreen}
            paneVisible={paneVisible}
            onEnterFullscreen={onEnterFullscreen}
            onExitFullscreen={onExitFullscreen}
            settingsEnabled={chartPreferences.hydrated}
            onIndicatorChange={handleIndicatorChange}
            onSettings={() => setSettingsVisible(true)}
          />
          <View style={styles.chartViewport}>
            <View
              style={styles.nativeChart}
              testID="market-detail-native-chart"
            >
              <MobileKlineChart
                currentPrice={price}
                error={fallbackError}
                height={fallbackChartHeight}
                indicatorConfig={chartPreferences.config}
                interval={interval}
                items={fallbackKlines}
                loading={fallbackLoading && fallbackKlines.length === 0}
                pricePrecision={displayPricePrecision}
                referencePriceLines={referencePriceLines}
                showPane={paneVisible}
                statusNote={fallbackStatusNote}
                testID="native-kline-chart"
                visibleCount={fullscreen ? 96 : 36}
                onIntervalChange={onIntervalChange}
              />
            </View>
          </View>
        </View>

        {!fullscreen ? (
          <View
            style={[
              styles.marketPanel,
              portraitLayout.mode === 'regular'
                ? styles.marketPanelExpanded
                : portraitLayout.mode === 'compact'
                ? styles.marketPanelCompact
                : styles.marketPanelExtreme,
            ]}
            testID="market-detail-panel"
          >
            {realtimeError ? (
              <Text numberOfLines={1} style={styles.marketError}>
                {t('marketDetail.realtimeError')}
              </Text>
            ) : null}
            <DetailTabs active={activeTab} onChange={setActiveTab} />
            {activeTab === 'depth' ? (
              <DepthTable
                asks={visibleAsks}
                baseAsset={baseAsset}
                bids={visibleBids}
                pricePrecision={displayPricePrecision}
                referencePrice={price}
              />
            ) : activeTab === 'trades' ? (
              <TradesTable
                baseAsset={baseAsset}
                pricePrecision={displayPricePrecision}
                trades={trades.slice(0, bookRows + 1)}
              />
            ) : (
              <InfoTable
                category={category}
                market={market}
                marketStatus={marketStatus}
                pricePrecision={displayPricePrecision}
                realtimePhase={realtimePhase}
                symbol={symbol}
              />
            )}
          </View>
        ) : null}
        <AdvancedChartIndicatorSettingsSheet
          preferences={chartPreferences.preferences}
          visible={settingsVisible && chartPreferences.hydrated}
          onApply={chartPreferences.commitPreferences}
          onClose={() => setSettingsVisible(false)}
        />
      </View>
    </SafeAreaView>
  );
}

function IndicatorToolbar({
  activeIndicators,
  canEnterFullscreen,
  disabled,
  fullscreen,
  paneVisible,
  onEnterFullscreen,
  onExitFullscreen,
  onIndicatorChange,
  onSettings,
  settingsEnabled,
}: {
  activeIndicators: AdvancedChartIndicators;
  canEnterFullscreen: boolean;
  disabled: boolean;
  fullscreen: boolean;
  paneVisible: boolean;
  onEnterFullscreen: () => void;
  onExitFullscreen: () => void;
  onIndicatorChange: (indicator: AdvancedChartIndicator) => void;
  onSettings: () => void;
  settingsEnabled: boolean;
}) {
  const { t } = useLanguage();
  const indicatorScrollMetrics = useRef<HorizontalOverflowMetrics>({
    contentWidth: 0,
    offsetX: 0,
    viewportWidth: 0,
  });
  const [indicatorOverflow, setIndicatorOverflow] = useState(() =>
    getHorizontalOverflowPresentation(indicatorScrollMetrics.current),
  );
  const updateIndicatorOverflow = useCallback(
    (next: Partial<HorizontalOverflowMetrics>) => {
      indicatorScrollMetrics.current = {
        ...indicatorScrollMetrics.current,
        ...next,
      };
      const presentation = getHorizontalOverflowPresentation(
        indicatorScrollMetrics.current,
      );
      setIndicatorOverflow(current =>
        current.atEnd === presentation.atEnd &&
        current.hasOverflow === presentation.hasOverflow
          ? current
          : presentation,
      );
    },
    [],
  );
  return (
    <View
      style={styles.indicatorToolbar}
      testID="market-detail-indicator-toolbar"
    >
      <ScrollView
        horizontal
        contentContainerStyle={styles.indicatorScrollContent}
        scrollEventThrottle={32}
        showsHorizontalScrollIndicator={false}
        style={styles.indicatorScroll}
        testID="market-detail-indicator-scroll"
        onContentSizeChange={contentWidth =>
          updateIndicatorOverflow({ contentWidth })
        }
        onLayout={event =>
          updateIndicatorOverflow({
            viewportWidth: event.nativeEvent.layout.width,
          })
        }
        onScroll={event =>
          updateIndicatorOverflow({
            offsetX: event.nativeEvent.contentOffset.x,
          })
        }
      >
        {ADVANCED_CHART_INDICATORS.map((indicator, index) => {
          const selected =
            activeIndicators.overlay === indicator ||
            (paneVisible && activeIndicators.pane === indicator);
          return (
            <React.Fragment key={indicator}>
              {index === ADVANCED_CHART_OVERLAY_INDICATORS.length ? (
                <View style={styles.indicatorDivider} />
              ) : null}
              <Pressable
                accessibilityLabel={t('marketDetail.indicatorA11y', {
                  indicator,
                })}
                accessibilityRole="button"
                accessibilityState={{ disabled, selected }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
                disabled={disabled}
                style={({ pressed }) => [
                  styles.indicatorButton,
                  pressed ? styles.pressed : null,
                ]}
                testID={`market-detail-indicator-${indicator.toLowerCase()}`}
                onPress={() => onIndicatorChange(indicator)}
              >
                <Text
                  style={[
                    styles.indicatorText,
                    selected ? styles.indicatorTextActive : null,
                    disabled ? styles.indicatorTextDisabled : null,
                  ]}
                >
                  {indicator}
                </Text>
              </Pressable>
            </React.Fragment>
          );
        })}
      </ScrollView>
      <View
        pointerEvents="none"
        style={[
          styles.indicatorOverflowCue,
          indicatorOverflow.hasOverflow && !indicatorOverflow.atEnd
            ? null
            : styles.indicatorOverflowCueHidden,
        ]}
        testID="market-detail-indicator-overflow-cue"
      >
        <ChevronRight color={colors.textMuted} size={13} strokeWidth={2.2} />
      </View>
      <View style={styles.settingsSlot}>
        <Pressable
          accessibilityLabel={t('marketDetail.indicatorSettingsA11y')}
          accessibilityRole="button"
          accessibilityState={{ disabled: !settingsEnabled }}
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          disabled={!settingsEnabled}
          style={({ pressed }) => [
            styles.settingsButton,
            !settingsEnabled ? styles.fullscreenButtonDisabled : null,
            pressed ? styles.pressed : null,
          ]}
          testID="market-detail-indicator-settings"
          onPress={onSettings}
        >
          <SlidersHorizontal
            color={settingsEnabled ? colors.text : colors.textSubtle}
            size={18}
            strokeWidth={2.1}
          />
        </Pressable>
      </View>
      <View style={styles.fullscreenSlot}>
        <Pressable
          accessibilityLabel={
            fullscreen
              ? t('marketDetail.exitFullscreenA11y')
              : t('marketDetail.fullscreenA11y')
          }
          accessibilityRole="button"
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          disabled={!fullscreen && !canEnterFullscreen}
          hitSlop={8}
          style={({ pressed }) => [
            styles.fullscreenButton,
            !fullscreen && !canEnterFullscreen
              ? styles.fullscreenButtonDisabled
              : null,
            pressed ? styles.pressed : null,
          ]}
          testID="market-detail-fullscreen-button"
          onPress={fullscreen ? onExitFullscreen : onEnterFullscreen}
        >
          {fullscreen ? (
            <Minimize2 color={colors.text} size={19} strokeWidth={2.1} />
          ) : (
            <Maximize2
              color={canEnterFullscreen ? colors.text : colors.textSubtle}
              size={19}
              strokeWidth={2.1}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function PortraitHeader({
  baseAsset,
  market,
  symbolLabel,
  onBack,
}: {
  baseAsset: string;
  market: 'spot' | 'contract';
  symbolLabel: string;
  onBack: () => void;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.portraitHeader}>
      <Pressable
        accessibilityLabel={t('marketDetail.backToTradingA11y')}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.12)', borderless: true }}
        hitSlop={8}
        style={({ pressed }) => [
          styles.headerButton,
          pressed ? styles.pressed : null,
        ]}
        onPress={onBack}
      >
        <ArrowLeft color={colors.text} size={24} strokeWidth={2.2} />
      </Pressable>
      <View style={styles.assetAvatar}>
        <Text style={styles.assetAvatarText}>{baseAsset.slice(0, 2)}</Text>
      </View>
      <Text numberOfLines={1} style={styles.headerSymbol}>
        {symbolLabel}
      </Text>
      <View style={styles.marketBadge}>
        <Text style={styles.marketBadgeText}>
          {market === 'spot'
            ? t('marketDetail.spot')
            : t('marketDetail.contract')}
        </Text>
      </View>
      <View style={styles.headerSpacer} />
    </View>
  );
}

function LandscapeHeader({
  symbolLabel,
  price,
  pricePrecision,
  priceColor,
  changePercent,
  onBack,
}: {
  symbolLabel: string;
  price: number | null;
  pricePrecision: number;
  priceColor: string;
  changePercent: number | null;
  onBack: () => void;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.landscapeHeader}>
      <Pressable
        accessibilityLabel={t('marketDetail.exitLandscapeA11y')}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.12)', borderless: true }}
        hitSlop={8}
        style={({ pressed }) => [
          styles.headerButton,
          styles.landscapeBackButton,
          pressed ? styles.pressed : null,
        ]}
        onPress={onBack}
      >
        <ArrowLeft color={colors.text} size={22} strokeWidth={2.2} />
      </Pressable>
      <Text numberOfLines={1} style={styles.landscapeSymbol}>
        {symbolLabel}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.landscapePrice, { color: priceColor }]}
      >
        {formatNumber(price, pricePrecision)}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.landscapeChange, { color: priceColor }]}
      >
        {formatPercent(changePercent)}
      </Text>
    </View>
  );
}

function MarketSummary({
  baseAsset,
  quoteAsset,
  price,
  markPrice,
  changePercent,
  high24h,
  low24h,
  baseVolume24h,
  quoteVolume24h,
  pricePrecision,
  priceColor,
}: {
  baseAsset: string;
  quoteAsset: string;
  price: number | null;
  markPrice: number | null;
  changePercent: number | null;
  high24h: number | null;
  low24h: number | null;
  baseVolume24h: number | null;
  quoteVolume24h: number | null;
  pricePrecision: number;
  priceColor: string;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.summary}>
      <View style={styles.summaryPriceColumn}>
        <Text
          numberOfLines={1}
          style={[styles.bigPrice, { color: priceColor }]}
        >
          {formatNumber(price, pricePrecision)}
        </Text>
        <Text style={[styles.bigChange, { color: priceColor }]}>
          {formatPercent(changePercent)}
        </Text>
        {markPrice !== null ? (
          <Text style={styles.markPrice}>
            {t('marketDetail.markPrice', {
              price: formatNumber(markPrice, pricePrecision),
            })}
          </Text>
        ) : null}
      </View>
      <View style={styles.statGrid} testID="market-summary-stat-grid">
        <View style={styles.statRow} testID="market-summary-stat-row-primary">
          <Stat
            label={t('marketDetail.high24h')}
            value={formatNumber(high24h, pricePrecision)}
          />
          <Stat
            divider
            label={t('marketDetail.baseVolume24h', { asset: baseAsset })}
            value={formatCompact(baseVolume24h)}
          />
        </View>
        <View style={styles.statRow} testID="market-summary-stat-row-secondary">
          <Stat
            label={t('marketDetail.low24h')}
            value={formatNumber(low24h, pricePrecision)}
          />
          <Stat
            divider
            label={t('marketDetail.quoteVolume24h', { asset: quoteAsset })}
            value={formatCompact(quoteVolume24h)}
          />
        </View>
      </View>
    </View>
  );
}

function Stat({
  divider = false,
  label,
  value,
}: {
  divider?: boolean;
  label: string;
  value: string;
}) {
  return (
    <View style={[styles.stat, divider ? styles.statDivider : null]}>
      <Text numberOfLines={1} style={styles.statLabel}>
        {label}
      </Text>
      <Text numberOfLines={1} style={styles.statValue}>
        {value}
      </Text>
    </View>
  );
}

function DetailTabs({
  active,
  onChange,
}: {
  active: DetailTab;
  onChange: (tab: DetailTab) => void;
}) {
  const { t } = useLanguage();
  const tabs: Array<{ key: DetailTab; label: string }> = [
    { key: 'depth', label: t('marketDetail.tab.depth') },
    { key: 'trades', label: t('marketDetail.tab.trades') },
    { key: 'info', label: t('marketDetail.tab.info') },
  ];
  return (
    <View style={styles.detailTabs}>
      {tabs.map(tab => (
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: active === tab.key }}
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          key={tab.key}
          style={({ pressed }) => [
            styles.detailTab,
            pressed ? styles.pressed : null,
          ]}
          testID={`market-detail-tab-${tab.key}`}
          onPress={() => onChange(tab.key)}
        >
          <Text
            style={[
              styles.detailTabText,
              active === tab.key ? styles.detailTabTextActive : null,
            ]}
          >
            {tab.label}
          </Text>
          <View
            style={[
              styles.detailTabIndicator,
              active === tab.key ? styles.detailTabIndicatorActive : null,
            ]}
          />
        </Pressable>
      ))}
    </View>
  );
}

function DepthTable({
  bids,
  asks,
  baseAsset,
  pricePrecision,
  referencePrice,
}: {
  bids: SpotOrderBookLevel[];
  asks: SpotOrderBookLevel[];
  baseAsset: string;
  pricePrecision: number;
  referencePrice: number | null;
}) {
  const { t } = useLanguage();
  const rowCount = Math.max(bids.length, asks.length);
  const bidDepths = cumulativeDepths(bids);
  const askDepths = cumulativeDepths(asks);
  const maximumDepth = Math.max(
    bidDepths[bidDepths.length - 1] ?? 0,
    askDepths[askDepths.length - 1] ?? 0,
  );
  const bestBid = usableDepthPrice(bids[0]?.price);
  const bestAsk = usableDepthPrice(asks[0]?.price);
  const latestPrice = usableDepthPrice(referencePrice);

  return (
    <View style={styles.depthTable} testID="market-detail-depth">
      <View style={styles.depthHeaderRow}>
        <View style={styles.depthHalf}>
          <Text style={[styles.depthHeader, styles.alignLeft]}>
            {t('marketDetail.quantity', { asset: baseAsset })}
          </Text>
          <Text style={[styles.depthHeader, styles.alignRight]}>
            {t('marketDetail.bidPrice')}
          </Text>
        </View>
        <View style={[styles.depthHalf, styles.depthAskHalf]}>
          <Text style={[styles.depthHeader, styles.alignLeft]}>
            {t('marketDetail.askPrice')}
          </Text>
          <Text style={[styles.depthHeader, styles.alignRight]}>
            {t('marketDetail.quantity', { asset: baseAsset })}
          </Text>
        </View>
      </View>
      <View style={styles.depthReferenceRow}>
        <Text numberOfLines={1} style={[styles.depthBestPrice, styles.bidText]}>
          {formatNumber(bestBid, pricePrecision)}
        </Text>
        <View style={styles.depthReferenceCenter}>
          <Text
            numberOfLines={1}
            style={styles.depthMidpoint}
            testID="market-detail-depth-reference"
          >
            {t('marketDetail.latestPrice', { price: '' })}
            {formatNumber(latestPrice, pricePrecision)}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={[styles.depthBestPrice, styles.askText, styles.alignRight]}
        >
          {formatNumber(bestAsk, pricePrecision)}
        </Text>
      </View>
      {rowCount > 0 ? (
        Array.from({ length: rowCount }).map((_, index) => {
          const bid = bids[index];
          const ask = asks[index];
          return (
            <View
              key={`depth-${index}`}
              style={styles.depthRow}
              testID={`market-detail-depth-row-${index}`}
            >
              <View style={styles.depthHalf}>
                <View
                  pointerEvents="none"
                  style={[
                    styles.depthBar,
                    styles.bidDepthBar,
                    { width: depthWidth(bidDepths[index], maximumDepth) },
                  ]}
                  testID={`market-detail-bid-depth-${index}`}
                />
                <Text
                  style={[styles.depthCell, styles.alignLeft]}
                  testID={`market-detail-bid-amount-${index}`}
                >
                  {formatDepthAmount(bid?.amount ?? null)}
                </Text>
                <Text
                  style={[
                    styles.depthCell,
                    styles.depthPrice,
                    styles.bidText,
                    styles.alignRight,
                  ]}
                >
                  {formatNumber(bid?.price ?? null, pricePrecision)}
                </Text>
              </View>
              <View style={[styles.depthHalf, styles.depthAskHalf]}>
                <View
                  pointerEvents="none"
                  style={[
                    styles.depthBar,
                    styles.askDepthBar,
                    { width: depthWidth(askDepths[index], maximumDepth) },
                  ]}
                  testID={`market-detail-ask-depth-${index}`}
                />
                <Text
                  style={[
                    styles.depthCell,
                    styles.depthPrice,
                    styles.askText,
                    styles.alignLeft,
                  ]}
                >
                  {formatNumber(ask?.price ?? null, pricePrecision)}
                </Text>
                <Text
                  style={[styles.depthCell, styles.alignRight]}
                  testID={`market-detail-ask-amount-${index}`}
                >
                  {formatDepthAmount(ask?.amount ?? null)}
                </Text>
              </View>
            </View>
          );
        })
      ) : (
        <Text style={styles.depthEmptyText} testID="market-detail-depth-empty">
          {t('marketDetail.emptyDepth')}
        </Text>
      )}
    </View>
  );
}

function TradesTable({
  trades,
  baseAsset,
  pricePrecision,
}: {
  trades: SpotTrade[];
  baseAsset: string;
  pricePrecision: number;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.table} testID="market-detail-trades">
      <View style={styles.tableRow}>
        <Text style={[styles.tradeHeader, styles.alignLeft]}>
          {t('marketDetail.time')}
        </Text>
        <Text style={styles.tradeHeader}>{t('marketDetail.price')}</Text>
        <Text style={[styles.tradeHeader, styles.alignRight]}>
          {t('marketDetail.quantity', { asset: baseAsset })}
        </Text>
      </View>
      {trades.length > 0 ? (
        trades.map(trade => (
          <View key={trade.id} style={styles.tableRow}>
            <Text style={[styles.tradeCell, styles.alignLeft]}>
              {formatTradeTime(trade.ts)}
            </Text>
            <Text
              style={[
                styles.tradeCell,
                trade.side === 'SELL' ? styles.askText : styles.bidText,
              ]}
            >
              {formatNumber(trade.price, pricePrecision)}
            </Text>
            <Text style={[styles.tradeCell, styles.alignRight]}>
              {formatCompact(trade.amount)}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>{t('marketDetail.emptyTrades')}</Text>
      )}
    </View>
  );
}

function InfoTable({
  market,
  category,
  symbol,
  marketStatus,
  realtimePhase,
  pricePrecision,
}: {
  market: 'spot' | 'contract';
  category?: AdvancedChartCategory;
  symbol: string;
  marketStatus?: string | null;
  realtimePhase?: string | null;
  pricePrecision: number;
}) {
  const { t } = useLanguage();
  return (
    <View style={styles.infoTable} testID="market-detail-info">
      <InfoRow label={t('marketDetail.tradingSymbol')} value={symbol} />
      <InfoRow
        label={t('marketDetail.marketType')}
        value={
          market === 'spot'
            ? t('marketDetail.spot')
            : category === 'stock'
            ? t('marketDetail.stockContract')
            : t('marketDetail.contract')
        }
      />
      <InfoRow
        label={t('marketDetail.marketStatus')}
        value={marketStatus || '--'}
      />
      <InfoRow
        label={t('marketDetail.realtimeConnection')}
        value={realtimePhase || '--'}
      />
      <InfoRow
        label={t('marketDetail.displayPrecision')}
        value={String(pricePrecision)}
      />
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.infoValue}>
        {value}
      </Text>
    </View>
  );
}

function formatNumber(value: number | null | undefined, precision = 2) {
  return formatFixedPrice(value, precision);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

function formatCompact(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  const absolute = Math.abs(value);
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [threshold, suffix] of units) {
    if (absolute >= threshold) {
      return `${(value / threshold).toFixed(2)}${suffix}`;
    }
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function isUsableDepthLevel(level: SpotOrderBookLevel) {
  return (
    Number.isFinite(level.price) &&
    level.price > 0 &&
    Number.isFinite(level.amount) &&
    level.amount > 0
  );
}

function formatDepthAmount(value: number | null | undefined) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return '--';
  }
  const absolute = Math.abs(value);
  if (absolute >= 1_000) return formatCompact(value);

  const significantPrecision = Math.max(
    4,
    Math.ceil(-Math.log10(absolute)) + 3,
  );
  const formatted = value.toLocaleString('en-US', {
    maximumFractionDigits: Math.min(12, significantPrecision),
  });
  return formatted === '0' ? '<0.000000000001' : formatted;
}

function formatTradeTime(value: SpotTrade['ts']) {
  if (value === null || value === undefined || value === '') return '--';
  let timestamp: number;
  if (typeof value === 'number') {
    timestamp = value < 10_000_000_000 ? value * 1000 : value;
  } else {
    const numeric = Number(value);
    timestamp = Number.isFinite(numeric)
      ? numeric < 10_000_000_000
        ? numeric * 1000
        : numeric
      : Date.parse(value);
  }
  if (!Number.isFinite(timestamp)) return '--';
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':');
}

function resolvePortraitLayout(height: number) {
  if (height < 620) {
    return {
      mode: 'extreme' as const,
      chartHeight: 176,
      bookRows: 2,
    };
  }
  if (height < 700) {
    return {
      mode: 'compact' as const,
      chartHeight: 204,
      bookRows: 3,
    };
  }
  return {
    mode: 'regular' as const,
    chartHeight: Math.min(316, Math.round(height * 0.38)),
    bookRows: height >= 900 ? 9 : height >= 820 ? 8 : 7,
  };
}

function cumulativeDepths(levels: SpotOrderBookLevel[]) {
  let total = 0;
  return levels.map(level => {
    if (Number.isFinite(level.amount) && level.amount > 0) {
      total += level.amount;
    }
    return total;
  });
}

function usableDepthPrice(value: number | null | undefined) {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}

function depthWidth(
  depth: number | null | undefined,
  maximumDepth: number,
): DimensionValue {
  if (
    depth === null ||
    depth === undefined ||
    !Number.isFinite(depth) ||
    depth <= 0 ||
    !Number.isFinite(maximumDepth) ||
    maximumDepth <= 0
  ) {
    return '0%';
  }
  const percentage = Math.min(100, (depth / maximumDepth) * 100);
  const roundedPercentage = Math.round(percentage * 10) / 10;
  return `${roundedPercentage}%`;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.76, transform: [{ scale: 0.985 }] },
  safe: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1, backgroundColor: colors.bg },
  portraitHeader: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  landscapeHeader: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerButton: {
    width: 24,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  landscapeBackButton: { width: 44, height: 42 },
  headerSpacer: { width: 36 },
  assetAvatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
    marginRight: 9,
    backgroundColor: colors.gold,
  },
  assetAvatarText: { ...typography.heavy, color: colors.black, fontSize: 10 },
  headerSymbol: {
    ...typography.heavy,
    flexShrink: 1,
    color: colors.text,
    fontSize: 16,
  },
  marketBadge: {
    marginLeft: 7,
    borderRadius: 4,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  marketBadgeText: {
    ...typography.bold,
    color: colors.textMuted,
    fontSize: 10,
  },
  landscapeSymbol: {
    ...typography.heavy,
    minWidth: 0,
    maxWidth: '32%',
    flexShrink: 1,
    color: colors.text,
    fontSize: 15,
  },
  landscapePrice: {
    ...typography.number,
    minWidth: 0,
    maxWidth: '34%',
    flexShrink: 1,
    fontSize: 17,
    fontWeight: '900',
  },
  landscapeChange: {
    ...typography.number,
    maxWidth: 72,
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '800',
  },
  summary: {
    minHeight: 104,
    flexDirection: 'row',
    alignItems: 'stretch',
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.card,
  },
  summaryPriceColumn: {
    flex: 0.95,
    minWidth: 0,
    justifyContent: 'center',
    paddingRight: 12,
    borderRightWidth: 1,
    borderRightColor: colors.line,
  },
  bigPrice: { ...typography.number, fontSize: 25, fontWeight: '900' },
  bigChange: {
    ...typography.number,
    marginTop: 2,
    fontSize: 12,
    fontWeight: '800',
  },
  markPrice: {
    ...typography.number,
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 10,
  },
  statGrid: {
    flex: 1.2,
    minWidth: 0,
    justifyContent: 'center',
    paddingLeft: 12,
  },
  statRow: { minHeight: 38, flexDirection: 'row', alignItems: 'stretch' },
  stat: { flex: 1, minWidth: 0, justifyContent: 'center' },
  statDivider: {
    marginLeft: 8,
    paddingLeft: 8,
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
  },
  statLabel: {
    ...typography.medium,
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  statValue: {
    ...typography.number,
    marginTop: 2,
    color: colors.text,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
  },
  chartShell: {
    position: 'relative',
    minHeight: 0,
    marginHorizontal: 10,
    marginVertical: 7,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.bgElevated,
  },
  chartShellFullscreen: {
    flex: 1,
    marginHorizontal: 0,
    marginBottom: 0,
    marginTop: 0,
    borderWidth: 0,
    borderRadius: 0,
  },
  indicatorToolbar: {
    height: 42,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg,
  },
  indicatorScroll: { flex: 1, minWidth: 0 },
  indicatorScrollContent: { alignItems: 'center', paddingHorizontal: 2 },
  indicatorOverflowCue: {
    position: 'absolute',
    top: 0,
    right: 92,
    bottom: 1,
    zIndex: 2,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
    backgroundColor: colors.bg,
  },
  indicatorOverflowCueHidden: { opacity: 0 },
  indicatorButton: {
    minWidth: 34,
    height: 41,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  indicatorText: { ...typography.bold, color: colors.textMuted, fontSize: 12 },
  indicatorTextActive: { color: colors.gold },
  indicatorTextDisabled: { opacity: 0.45 },
  indicatorDivider: {
    width: 1,
    height: 16,
    marginHorizontal: 4,
    backgroundColor: colors.line,
  },
  settingsSlot: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
    backgroundColor: colors.bg,
  },
  settingsButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
  },
  fullscreenSlot: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
    backgroundColor: colors.bg,
  },
  fullscreenButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(5,5,5,0.78)',
  },
  fullscreenButtonDisabled: { opacity: 0.55 },
  chartViewport: { flex: 1, minHeight: 0 },
  nativeChart: {
    flex: 1,
    minHeight: 0,
    padding: 8,
  },
  marketPanel: {
    marginHorizontal: 12,
    marginBottom: 8,
    overflow: 'hidden',
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  marketPanelExpanded: { flex: 1, minHeight: 220 },
  marketPanelCompact: { height: 170 },
  marketPanelExtreme: { height: 148 },
  marketError: {
    ...typography.medium,
    paddingTop: 4,
    color: colors.warning,
    fontSize: 9,
  },
  detailTabs: { height: 42, flexDirection: 'row', alignItems: 'stretch' },
  detailTab: {
    flex: 1,
    minWidth: 0,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailTabText: { ...typography.bold, color: colors.textMuted, fontSize: 12 },
  detailTabTextActive: { color: colors.text },
  detailTabIndicator: {
    position: 'absolute',
    bottom: 0,
    width: 22,
    height: 2,
    borderRadius: 1,
  },
  detailTabIndicatorActive: { backgroundColor: colors.gold },
  table: { flex: 1, paddingTop: 4 },
  tableRow: { minHeight: 22, flexDirection: 'row', alignItems: 'center' },
  tableHeader: {
    ...typography.medium,
    width: '25%',
    color: colors.textSubtle,
    fontSize: 9,
    textAlign: 'center',
  },
  tableCell: {
    ...typography.number,
    width: '25%',
    color: colors.textMuted,
    fontSize: 10,
    textAlign: 'center',
  },
  depthTable: { flex: 1, paddingTop: 3 },
  depthHeaderRow: { minHeight: 18, flexDirection: 'row', alignItems: 'center' },
  depthHalf: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  depthAskHalf: {
    marginLeft: 10,
    paddingLeft: 10,
    borderLeftWidth: 1,
    borderLeftColor: colors.line,
  },
  depthHeader: {
    ...typography.medium,
    flex: 1,
    minWidth: 0,
    color: colors.textSubtle,
    fontSize: 9,
  },
  depthReferenceRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: colors.bgElevated,
  },
  depthBestPrice: {
    ...typography.number,
    flex: 1,
    minWidth: 0,
    fontSize: 10,
    fontWeight: '800',
  },
  depthReferenceCenter: { flex: 1.25, minWidth: 0, alignItems: 'center' },
  depthMidpoint: {
    ...typography.number,
    color: colors.text,
    fontSize: 9,
    fontWeight: '700',
  },
  depthRow: { minHeight: 19, flexDirection: 'row', alignItems: 'stretch' },
  depthBar: { position: 'absolute', top: 1, bottom: 1 },
  bidDepthBar: { right: 0, backgroundColor: 'rgba(25,195,125,0.13)' },
  askDepthBar: { left: 0, backgroundColor: 'rgba(240,90,90,0.13)' },
  depthCell: {
    ...typography.number,
    zIndex: 1,
    width: '50%',
    color: colors.textMuted,
    fontSize: 9,
  },
  depthPrice: { fontWeight: '700' },
  depthEmptyText: {
    ...typography.medium,
    paddingTop: 18,
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'center',
  },
  tradeHeader: {
    ...typography.medium,
    width: '33.333%',
    color: colors.textSubtle,
    fontSize: 9,
    textAlign: 'center',
  },
  tradeCell: {
    ...typography.number,
    width: '33.333%',
    color: colors.textMuted,
    fontSize: 10,
    textAlign: 'center',
  },
  alignLeft: { textAlign: 'left' },
  alignRight: { textAlign: 'right' },
  bidText: { color: colors.green },
  askText: { color: colors.red },
  emptyText: {
    ...typography.medium,
    paddingTop: 20,
    color: colors.textSubtle,
    fontSize: 11,
    textAlign: 'center',
  },
  infoTable: { flex: 1, paddingTop: 4 },
  infoRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  infoLabel: { ...typography.medium, color: colors.textSubtle, fontSize: 10 },
  infoValue: {
    ...typography.number,
    maxWidth: '70%',
    color: colors.text,
    fontSize: 10,
  },
});
