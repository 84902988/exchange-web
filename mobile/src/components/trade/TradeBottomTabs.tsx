import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  formatSpotNumber,
  type SpotMyTradeItem,
  type SpotOrderItem,
} from '../../api/spot';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';
import { formatFixedPrice } from '../../utils/format';
import { formatTradingRecordTime } from '../../utils/tradingRecordTime';

export type TradeRecordTab = 'current' | 'history' | 'fills';

type Props = {
  activeTab: TradeRecordTab;
  isLoggedIn: boolean;
  currentOrders: SpotOrderItem[];
  historyOrders: SpotOrderItem[];
  fills: SpotMyTradeItem[];
  cancelingOrderIds: readonly number[];
  amountPrecision?: number;
  baseAsset?: string;
  pricePrecision?: number;
  quoteAsset?: string;
  symbolLabel?: string;
  error?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string | null;
  onChange: (tab: TradeRecordTab) => void;
  onCancelPress: (order: SpotOrderItem) => void;
  onLoadMore?: () => void;
  onLoginPress: () => void;
  onRetryPress?: () => void;
};

function TradeBottomTabs({
  activeTab,
  isLoggedIn,
  currentOrders,
  historyOrders,
  fills,
  cancelingOrderIds,
  amountPrecision = 6,
  baseAsset = '',
  pricePrecision = 2,
  quoteAsset = '',
  symbolLabel,
  error,
  hasMore = false,
  loadingMore = false,
  loadMoreError,
  onChange,
  onCancelPress,
  onLoadMore,
  onLoginPress,
  onRetryPress,
}: Props) {
  const { t } = useLanguage();
  const tabs: Array<{ key: TradeRecordTab; label: string }> = [
    { key: 'current', label: t('trading.tab.currentOrders') },
    { key: 'history', label: t('trading.tab.historyOrders') },
    { key: 'fills', label: t('trading.tab.fills') },
  ];
  const items =
    activeTab === 'current'
      ? currentOrders
      : activeTab === 'history'
      ? historyOrders
      : fills;

  return (
    <View style={styles.card}>
      <View style={styles.tabs}>
        {tabs.map(tab => {
          const active = tab.key === activeTab;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              key={tab.key}
              style={({ pressed }) => [
                styles.tab,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onChange(tab.key)}
            >
              <Text style={[styles.tabText, active ? styles.activeText : null]}>
                {tab.label}
              </Text>
              <View
                style={[
                  styles.indicator,
                  active ? styles.activeIndicator : null,
                ]}
              />
            </Pressable>
          );
        })}
      </View>

      {!isLoggedIn ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {t('trading.loginToViewRecords')}
          </Text>
          <Pressable
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(0, 0, 0, 0.14)' }}
            style={({ pressed }) => [
              styles.loginButton,
              pressed ? styles.submitPressed : null,
            ]}
            onPress={onLoginPress}
          >
            <Text style={styles.loginText}>{t('trading.login')}</Text>
          </Pressable>
        </View>
      ) : error ? (
        <View style={styles.errorState}>
          <Text style={styles.error}>{error}</Text>
          {onRetryPress ? (
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              style={({ pressed }) => [
                styles.retryButton,
                pressed ? styles.pressed : null,
              ]}
              onPress={onRetryPress}
            >
              <Text style={styles.retryButtonText}>{t('common.reload')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : items.length === 0 ? (
        <Text style={styles.placeholder}>{t('trading.noRecords')}</Text>
      ) : (
        <>
          <View style={styles.records}>
            {items.map(item => (
              <RecordRow
                activeTab={activeTab}
                amountPrecision={amountPrecision}
                baseAsset={baseAsset}
                cancelingOrderIds={cancelingOrderIds}
                item={item}
                key={item.id}
                pricePrecision={pricePrecision}
                quoteAsset={quoteAsset}
                symbolLabel={symbolLabel}
                onCancelPress={onCancelPress}
              />
            ))}
          </View>
          {(hasMore || loadMoreError) && onLoadMore ? (
            <View style={styles.loadMoreState}>
              {loadMoreError ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={styles.loadMoreError}
                >
                  {loadMoreError}
                </Text>
              ) : null}
              <Pressable
                accessibilityLabel={t(
                  loadingMore
                    ? 'trading.loadingMoreRecordsA11y'
                    : 'trading.loadMoreRecordsA11y',
                )}
                accessibilityRole="button"
                accessibilityState={{
                  busy: loadingMore,
                  disabled: loadingMore,
                }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                disabled={loadingMore}
                style={({ pressed }) => [
                  styles.loadMoreButton,
                  loadingMore ? styles.loadMoreButtonDisabled : null,
                  pressed ? styles.pressed : null,
                ]}
                onPress={onLoadMore}
              >
                <Text style={styles.loadMoreButtonText}>
                  {loadingMore
                    ? t('common.loading')
                    : loadMoreError
                    ? t('trading.retryLoad')
                    : t('common.loadMore')}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

export default React.memo(TradeBottomTabs);

export function getCancelableSpotOrderId(
  order: SpotOrderItem | SpotMyTradeItem,
) {
  if (!('orderId' in order)) return null;
  const status = String(order.status || '')
    .trim()
    .toUpperCase();
  if (status !== 'OPEN' && status !== 'PARTIALLY_FILLED') return null;
  return Number.isSafeInteger(order.orderId) && Number(order.orderId) > 0
    ? Number(order.orderId)
    : null;
}

function RecordRow({
  activeTab,
  amountPrecision,
  baseAsset,
  cancelingOrderIds,
  item,
  pricePrecision,
  quoteAsset,
  symbolLabel,
  onCancelPress,
}: {
  activeTab: TradeRecordTab;
  amountPrecision: number;
  baseAsset: string;
  cancelingOrderIds: readonly number[];
  item: SpotOrderItem | SpotMyTradeItem;
  pricePrecision: number;
  quoteAsset: string;
  symbolLabel?: string;
  onCancelPress: (order: SpotOrderItem) => void;
}) {
  const { t } = useLanguage();
  const side = t(item.side === 'SELL' ? 'trading.sell' : 'trading.buy');
  const sideColor = item.side === 'SELL' ? colors.red : colors.green;
  const order = 'orderId' in item ? item : null;
  const cancelableOrderId =
    activeTab === 'current' && order ? getCancelableSpotOrderId(order) : null;
  const canceling =
    cancelableOrderId !== null && cancelingOrderIds.includes(cancelableOrderId);
  const isFill = activeTab === 'fills';
  const priceLabel = t(isFill ? 'trading.fillPrice' : 'trading.orderPrice');
  const amountLabel = t(
    isFill ? 'trading.fillQuantity' : 'trading.orderProgress',
  );
  const priceValue =
    order && String(order.orderType).trim().toUpperCase() === 'MARKET'
      ? t('trading.market')
      : appendAsset(
          formatFixedPrice(Number(item.price), pricePrecision),
          quoteAsset,
        );
  const amountValue = order
    ? appendAsset(
        `${formatRecordAmount(
          order.filledAmount,
          amountPrecision,
        )} / ${formatRecordAmount(order.amount, amountPrecision)}`,
        baseAsset,
      )
    : appendAsset(
        formatRecordAmount(item.amount, amountPrecision),
        baseAsset,
      );
  const identityMeta = order
    ? `${symbolLabel || item.symbol} · ${formatOrderStatus(
        order.status,
        t,
      )} · ${t(
        String(order.orderType).trim().toUpperCase() === 'MARKET'
          ? 'trading.market'
          : 'trading.limit',
      )}`
    : symbolLabel || item.symbol;

  return (
    <View testID={`spot-record-${activeTab}-${item.id}`} style={styles.recordRow}>
      <View style={styles.recordHeader}>
        <View style={styles.recordIdentity}>
          <Text style={[styles.recordSide, { color: sideColor }]}>{side}</Text>
          <Text numberOfLines={1} style={styles.recordMeta}>
            {identityMeta}
          </Text>
        </View>
        <Text
          maxFontSizeMultiplier={1.2}
          numberOfLines={1}
          style={styles.recordTime}
        >
          {`${t(
            isFill ? 'trading.time.fill' : 'trading.time.order',
          )} ${formatTradingRecordTime(item.createdAt)}`}
        </Text>
        {cancelableOrderId !== null && order ? (
          <Pressable
            accessibilityLabel={t('trading.cancelOrderA11y', { id: order.id })}
            accessibilityRole="button"
            accessibilityState={{ disabled: canceling }}
            android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
            disabled={canceling}
            style={({ pressed }) => [
              styles.cancelButton,
              canceling ? styles.cancelButtonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onCancelPress(order)}
          >
            <Text style={styles.cancelButtonText}>
              {canceling ? t('trading.canceling') : t('trading.cancelOrder')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.recordMetrics}>
        <RecordMetric label={priceLabel} value={priceValue} />
        <RecordMetric label={amountLabel} value={amountValue} />
      </View>
    </View>
  );
}

function RecordMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.recordMetric}>
      <Text numberOfLines={1} style={styles.recordMetricLabel}>
        {label}
      </Text>
      <Text numberOfLines={1} style={styles.recordValue}>
        {value}
      </Text>
    </View>
  );
}

function formatRecordAmount(value: string, precision: number) {
  const parsed = Number(String(value).replace(/,/g, ''));
  return formatSpotNumber(parsed, precision);
}

function appendAsset(value: string, asset: string) {
  return asset ? `${value} ${asset}` : value;
}

function formatOrderStatus(status: string, t: Translator) {
  const normalized = String(status || '')
    .trim()
    .toUpperCase();
  if (normalized === 'OPEN') return t('trading.status.open');
  if (normalized === 'PARTIALLY_FILLED') return t('trading.status.partial');
  if (normalized === 'FILLED') return t('trading.status.filled');
  if (normalized === 'CANCELED') return t('trading.status.canceled');
  if (normalized === 'REJECTED') return t('trading.status.rejected');
  return normalized ? t('trading.status.updating') : '--';
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  submitPressed: { opacity: 0.86, transform: [{ scale: 0.992 }] },
  card: {
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  tabs: {
    flexDirection: 'row',
  },
  tab: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
  },
  activeText: {
    color: colors.gold,
    fontWeight: '900',
  },
  indicator: {
    position: 'absolute',
    bottom: 0,
    width: 18,
    height: 2,
    borderRadius: 1,
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
  empty: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: 12,
  },
  loginButton: {
    height: 44,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.gold,
  },
  loginText: {
    ...typography.bold,
    color: colors.black,
    fontSize: 12,
  },
  error: {
    color: colors.warning,
    fontSize: 12,
    textAlign: 'center',
  },
  errorState: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  retryButton: {
    minWidth: 92,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gold,
  },
  retryButtonText: {
    ...typography.semibold,
    color: colors.warning,
    fontSize: 11,
  },
  placeholder: {
    marginTop: 18,
    color: colors.textSubtle,
    fontSize: 12,
  },
  records: {
    marginTop: 8,
  },
  loadMoreState: {
    alignItems: 'center',
    gap: 8,
    paddingTop: 12,
  },
  loadMoreError: {
    color: colors.warning,
    fontSize: 11,
    textAlign: 'center',
  },
  loadMoreButton: {
    minWidth: 112,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  loadMoreButtonDisabled: {
    opacity: 0.55,
  },
  loadMoreButtonText: {
    ...typography.semibold,
    color: colors.textMuted,
    fontSize: 12,
  },
  recordRow: {
    minHeight: 64,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  recordHeader: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
  },
  recordIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recordSide: {
    ...typography.bold,
    fontSize: 12,
  },
  recordMeta: {
    flex: 1,
    minWidth: 0,
    color: colors.textSubtle,
    fontSize: 10,
  },
  recordMetrics: {
    marginTop: 7,
    flexDirection: 'row',
    gap: 12,
  },
  recordMetric: {
    flex: 1,
    minWidth: 0,
  },
  recordMetricLabel: {
    color: colors.textSubtle,
    fontSize: 9,
    lineHeight: 12,
  },
  recordValue: {
    ...typography.number,
    marginTop: 2,
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
  },
  recordTime: {
    flexShrink: 0,
    marginLeft: 8,
    color: colors.textSubtle,
    fontSize: 9,
  },
  cancelButton: {
    minWidth: 54,
    height: 28,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(246, 70, 93, 0.52)',
    backgroundColor: 'rgba(246, 70, 93, 0.12)',
  },
  cancelButtonDisabled: {
    opacity: 0.5,
  },
  cancelButtonText: {
    ...typography.semibold,
    color: colors.red,
    fontSize: 11,
  },
});
