import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  canCancelContractOrder,
  isContractOrderStatusCancelable,
  type ContractOrderItem,
  type ContractPositionItem,
  type ContractTradeItem,
} from '../../api/contract';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';
import { formatTradingRecordTime } from '../../utils/tradingRecordTime';

export type ContractRecordTab = 'positions' | 'current' | 'history' | 'fills';

type Props = {
  activeTab: ContractRecordTab;
  isLoggedIn: boolean;
  pricePrecision?: number;
  quantityPrecision?: number;
  positions: ContractPositionItem[];
  currentOrders: ContractOrderItem[];
  historyOrders: ContractOrderItem[];
  fills: ContractTradeItem[];
  cancelingOrderId?: number | null;
  orderActionFeedback?: {
    tone: 'error' | 'success';
    text: string;
  } | null;
  error?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadMoreError?: string | null;
  closingAllPositions?: boolean;
  closeAllPositionsDisabled?: boolean;
  onChange: (tab: ContractRecordTab) => void;
  onCancelOrder?: (order: ContractOrderItem) => void;
  onClosePosition?: (position: ContractPositionItem) => void;
  onEditPositionTpSl?: (position: ContractPositionItem) => void;
  onLoadMore?: () => void;
  onLoginPress: () => void;
  onRetryPress?: () => void;
  onCloseAllPositions?: () => void;
};

function ContractBottomTabs({
  activeTab,
  isLoggedIn,
  pricePrecision = 8,
  quantityPrecision = 8,
  positions,
  currentOrders,
  historyOrders,
  fills,
  cancelingOrderId = null,
  orderActionFeedback,
  error,
  hasMore = false,
  loadingMore = false,
  loadMoreError,
  closingAllPositions = false,
  closeAllPositionsDisabled = false,
  onChange,
  onCancelOrder,
  onClosePosition,
  onEditPositionTpSl,
  onLoadMore,
  onLoginPress,
  onRetryPress,
  onCloseAllPositions,
}: Props) {
  const { t } = useLanguage();
  const tabs: Array<{ key: ContractRecordTab; label: string }> = [
    {
      key: 'positions',
      label: t('trading.tab.positionsCount', { count: positions.length }),
    },
    {
      key: 'current',
      label: t('trading.tab.ordersCount', { count: currentOrders.length }),
    },
    { key: 'history', label: t('trading.tab.history') },
    { key: 'fills', label: t('trading.tab.fillsShort') },
  ];
  const items =
    activeTab === 'positions'
      ? positions
      : activeTab === 'current'
      ? currentOrders
      : activeTab === 'history'
      ? historyOrders
      : fills;
  const emptyCopy = getContractEmptyCopy(activeTab, t);
  return (
    <View style={styles.card}>
      <View style={styles.tabs}>
        {tabs.map(tab => {
          const active = tab.key === activeTab;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              style={({ pressed }) => [
                styles.tab,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => onChange(tab.key)}
            >
              <Text
                maxFontSizeMultiplier={1.2}
                numberOfLines={1}
                style={[styles.tabText, active ? styles.activeText : null]}
              >
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

      {isLoggedIn &&
      activeTab === 'positions' &&
      positions.length > 0 &&
      !error &&
      onCloseAllPositions ? (
        <View style={styles.closeAllRow}>
          <Text maxFontSizeMultiplier={1.2} style={styles.closeAllHint}>
            {t('contract.closeAllCurrentSymbolHint')}
          </Text>
          <Pressable
            accessibilityLabel={t('contract.closeAllCurrentSymbolA11y')}
            accessibilityRole="button"
            accessibilityState={{
              busy: closingAllPositions,
              disabled: closeAllPositionsDisabled,
            }}
            android_ripple={{color: 'rgba(240, 90, 90, 0.12)'}}
            disabled={closeAllPositionsDisabled}
            testID="contract-close-all-positions"
            style={({pressed}) => [
              styles.closeAllButton,
              closeAllPositionsDisabled ? styles.closeAllButtonDisabled : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={onCloseAllPositions}
          >
            <Text style={styles.closeAllButtonText}>
              {closingAllPositions
                ? t('contract.closeAllSubmitting')
                : t('contract.closeAll')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {!isLoggedIn ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {t('trading.loginToViewContractRecords')}
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
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {onRetryPress ? (
            <Pressable
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              testID="contract-records-retry"
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
        <>
          {activeTab === 'current' && orderActionFeedback ? (
            <OrderActionFeedback feedback={orderActionFeedback} />
          ) : null}
          <View style={styles.recordEmpty}>
            <Text maxFontSizeMultiplier={1.2} style={styles.placeholder}>
              {emptyCopy.title}
            </Text>
            <Text maxFontSizeMultiplier={1.2} style={styles.placeholderHint}>
              {emptyCopy.hint}
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.records}>
          {activeTab === 'current' && orderActionFeedback ? (
            <OrderActionFeedback feedback={orderActionFeedback} />
          ) : null}
          {items.map(item =>
            activeTab === 'positions' ? (
              <PositionRecord
                key={item.id}
                position={item as ContractPositionItem}
                pricePrecision={pricePrecision}
                quantityPrecision={quantityPrecision}
                onClosePosition={onClosePosition}
                onEditPositionTpSl={onEditPositionTpSl}
              />
            ) : (
              <RecordRow
                key={item.id}
                cancelingOrderId={cancelingOrderId}
                item={item}
                pricePrecision={pricePrecision}
                quantityPrecision={quantityPrecision}
                showCancelAction={activeTab === 'current'}
                onCancelOrder={onCancelOrder}
              />
            ),
          )}
          {loadMoreError ? (
            <Text accessibilityRole="alert" style={styles.loadMoreError}>
              {loadMoreError}
            </Text>
          ) : null}
          {hasMore && onLoadMore ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: loadingMore, disabled: loadingMore }}
              android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
              disabled={loadingMore}
              testID="contract-records-load-more"
              style={({ pressed }) => [
                styles.loadMoreButton,
                loadingMore ? styles.loadMoreButtonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={onLoadMore}
            >
              <Text style={styles.loadMoreButtonText}>
                {loadingMore ? t('common.loading') : t('common.loadMore')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

export default React.memo(ContractBottomTabs);

function PositionRecord({
  position,
  pricePrecision,
  quantityPrecision,
  onClosePosition,
  onEditPositionTpSl,
}: {
  position: ContractPositionItem;
  pricePrecision: number;
  quantityPrecision: number;
  onClosePosition?: (position: ContractPositionItem) => void;
  onEditPositionTpSl?: (position: ContractPositionItem) => void;
}) {
  const { t } = useLanguage();
  const isShort = position.side === 'SHORT';
  const displayPricePrecision = clampContractDisplayPrecision(pricePrecision);
  const displayQuantityPrecision =
    clampContractDisplayPrecision(quantityPrecision);
  const displayQuotePrecision = Math.max(2, displayPricePrecision);
  const pnlValue = Number(position.unrealizedPnl.replace(/,/g, ''));
  const pnlColor =
    Number.isFinite(pnlValue) && pnlValue !== 0
      ? pnlValue > 0
        ? colors.green
        : colors.red
      : colors.text;
  return (
    <View
      testID={`contract-position-${position.id}`}
      style={styles.positionRecord}
    >
      <View style={styles.positionHeader}>
        <View style={styles.positionIdentity}>
          <Text
            style={[
              styles.recordSide,
              { color: isShort ? colors.red : colors.green },
            ]}
          >
            {t(isShort ? 'trading.position.short' : 'trading.position.long')}
          </Text>
          <Text style={styles.positionSymbol}>{position.symbol}</Text>
        </View>
        <View style={styles.leverageBadge}>
          <Text style={styles.leverageText}>{`${position.leverage}x`}</Text>
        </View>
      </View>
      <View style={styles.positionMetrics}>
        <PositionMetric
          label={t('trading.position.quantity')}
          value={formatContractDisplayDecimal(
            position.quantity,
            displayQuantityPrecision,
          )}
        />
        <PositionMetric
          label={t('trading.position.entryPrice')}
          value={formatContractDisplayDecimal(
            position.entryPrice,
            displayPricePrecision,
            true,
          )}
        />
        <PositionMetric
          label={t('trading.position.markPrice')}
          value={formatContractDisplayDecimal(
            position.markPrice,
            displayPricePrecision,
            true,
          )}
        />
        <PositionMetric
          label={t('trading.position.margin')}
          value={formatContractDisplayDecimal(
            position.marginAmount,
            displayQuotePrecision,
          )}
        />
        <PositionMetric
          label={t('trading.position.unrealizedPnl')}
          value={formatContractDisplayDecimal(
            position.unrealizedPnl,
            displayQuotePrecision,
          )}
          valueColor={pnlColor}
        />
        <PositionMetric
          label={t('contract.takeProfit')}
          value={
            position.takeProfitPrice
                ? formatContractDisplayDecimal(
                    position.takeProfitPrice,
                    displayPricePrecision,
                    true,
                  )
              : t('contract.notSet')
          }
        />
        <PositionMetric
          label={t('contract.stopLoss')}
          value={
            position.stopLossPrice
                ? formatContractDisplayDecimal(
                    position.stopLossPrice,
                    displayPricePrecision,
                    true,
                  )
              : t('contract.notSet')
          }
        />
      </View>
      <RecordTime
        label={t('trading.time.opened')}
        value={position.openedAt}
      />
      <View style={styles.positionActions}>
        <Pressable
          accessibilityLabel={t('contract.positionClose')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
          testID={`contract-close-position-${position.id}`}
          style={({ pressed }) => [
            styles.positionAction,
            styles.closePositionAction,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => onClosePosition?.(position)}
        >
          <Text style={styles.closePositionActionText}>
            {t('contract.positionClose')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('contract.positionTpSl')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
          testID={`contract-tp-sl-position-${position.id}`}
          style={({ pressed }) => [
            styles.positionAction,
            styles.tpSlPositionAction,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => onEditPositionTpSl?.(position)}
        >
          <Text style={styles.tpSlPositionActionText}>
            {t('contract.positionTpSl')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function clampContractDisplayPrecision(value: number) {
  if (!Number.isFinite(value)) return 8;
  return Math.min(8, Math.max(0, Math.trunc(value)));
}

function formatContractDisplayDecimal(
  value: string,
  precision: number,
  fixedFractionDigits = false,
) {
  const raw = value.trim().replace(/,/g, '');
  const matched = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!matched) return value;

  const sign = matched[1] === '-' ? '-' : '';
  const whole = (matched[2] || '0').replace(/^0+(?=\d)/, '') || '0';
  const fraction = matched[3] || '';
  const scale = clampContractDisplayPrecision(precision);
  const keptFraction = fraction.slice(0, scale).padEnd(scale, '0');
  let scaled = BigInt(`${whole}${keptFraction}` || '0');
  if (fraction.length > scale && Number(fraction.charAt(scale)) >= 5) {
    scaled += 1n;
  }

  const digits = scaled.toString().padStart(scale + 1, '0');
  const roundedWhole = scale === 0 ? digits : digits.slice(0, -scale) || '0';
  const paddedRoundedFraction = scale === 0 ? '' : digits.slice(-scale);
  const roundedFraction = fixedFractionDigits
    ? paddedRoundedFraction
    : paddedRoundedFraction.replace(/0+$/, '');
  const isZero = roundedWhole === '0' && roundedFraction.length === 0;
  return `${sign && !isZero ? sign : ''}${roundedWhole}${
    roundedFraction ? `.${roundedFraction}` : ''
  }`;
}

function PositionMetric({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.positionMetric}>
      <Text style={styles.positionMetricLabel}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[
          styles.positionMetricValue,
          valueColor ? { color: valueColor } : null,
        ]}
      >
        {value || '--'}
      </Text>
    </View>
  );
}

function RecordRow({
  cancelingOrderId,
  item,
  pricePrecision,
  quantityPrecision,
  showCancelAction,
  onCancelOrder,
}: {
  cancelingOrderId: number | null;
  item: ContractPositionItem | ContractOrderItem | ContractTradeItem;
  pricePrecision: number;
  quantityPrecision: number;
  showCancelAction: boolean;
  onCancelOrder?: (order: ContractOrderItem) => void;
}) {
  const { t } = useLanguage();
  const isOrder = 'orderType' in item;
  const isShort =
    'positionSide' in item
      ? item.positionSide === 'SHORT'
      : item.side === 'SHORT';
  const label =
    'entryPrice' in item
      ? isShort
        ? t('trading.position.short')
        : t('trading.position.long')
      : `${formatContractAction(item.action, item.closeReason, t)}${t(
          isShort ? 'trading.position.short' : 'trading.position.long',
        )}`;
  const rawValue = 'entryPrice' in item ? item.entryPrice : item.price;
  const rawAmount = 'quantity' in item ? item.quantity : '--';
  const value = formatContractDisplayDecimal(
    rawValue,
    clampContractDisplayPrecision(pricePrecision),
    true,
  );
  const amount = formatContractDisplayDecimal(
    rawAmount,
    clampContractDisplayPrecision(quantityPrecision),
    true,
  );
  const meta = isOrder
    ? `${item.symbol} · ${formatContractOrderType(
        item.orderType,
        t,
      )} · ${formatContractStatus(item.status, t)}`
    : 'action' in item
    ? t('trading.record.filledMeta', {
        symbol: item.symbol,
        leverage: item.leverage,
      })
    : item.symbol;
  const statusCancelable =
    isOrder && isContractOrderStatusCancelable(item.status);
  const canCancel = isOrder && canCancelContractOrder(item);
  const cancelPending =
    isOrder && item.orderId !== null && cancelingOrderId === item.orderId;
  const cancelDisabled = !canCancel || cancelingOrderId !== null;
  const timeLabel = t(
    isOrder ? 'trading.time.order' : 'trading.time.fill',
  );
  const createdAt = 'createdAt' in item ? item.createdAt : null;
  return (
    <View testID={`contract-record-${item.id}`} style={styles.recordRow}>
      <View style={styles.recordMain}>
        <View style={styles.recordIdentity}>
          <View style={styles.recordTitleRow}>
            <Text
              style={[
                styles.recordSide,
                { color: isShort ? colors.red : colors.green },
              ]}
            >
              {label}
            </Text>
            <RecordTime inline label={timeLabel} value={createdAt} />
          </View>
          <Text
            maxFontSizeMultiplier={1.2}
            numberOfLines={1}
            style={styles.recordMeta}
          >
            {meta}
          </Text>
        </View>
        <View style={styles.recordRight}>
          <Text style={styles.recordValue}>{value}</Text>
          <Text style={styles.recordMeta}>{amount}</Text>
          {showCancelAction && isOrder && statusCancelable ? (
            <Pressable
              accessibilityLabel={t('trading.cancelOrderA11y', { id: item.id })}
              accessibilityRole="button"
              accessibilityState={{
                busy: cancelPending,
                disabled: cancelDisabled,
              }}
              android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
              disabled={cancelDisabled}
              testID={`contract-cancel-order-${item.id}`}
              style={({ pressed }) => [
                styles.cancelButton,
                cancelDisabled ? styles.cancelButtonDisabled : null,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => {
                if (canCancel) onCancelOrder?.(item);
              }}
            >
              <Text style={styles.cancelButtonText}>
                {cancelPending
                  ? t('trading.cancelingEllipsis')
                  : t('trading.cancelOrder')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function RecordTime({
  inline = false,
  label,
  value,
}: {
  inline?: boolean;
  label: string;
  value?: string | null;
}) {
  return (
    <Text
      maxFontSizeMultiplier={1.2}
      numberOfLines={1}
      style={[styles.recordTime, inline ? styles.recordTimeInline : null]}
    >
      {`${label} ${formatTradingRecordTime(value)}`}
    </Text>
  );
}

function formatContractAction(
  action: string,
  closeReason: string | null | undefined,
  t: Translator,
) {
  if (action.toUpperCase() === 'CLOSE') {
    const reasonLabels: Record<string, string> = {
      LIQUIDATION: t('trading.closeReason.liquidation'),
      TAKE_PROFIT: t('trading.closeReason.takeProfit'),
      STOP_LOSS: t('trading.closeReason.stopLoss'),
    };
    const reason = String(closeReason || '')
      .trim()
      .toUpperCase();
    return reasonLabels[reason] ?? t('trading.action.close');
  }
  return t(
    'trading.action.open',
  );
}

function formatContractOrderType(orderType: string, t: Translator) {
  return t(
    orderType.toUpperCase() === 'MARKET' ? 'trading.market' : 'trading.limit',
  );
}

function formatContractStatus(status: string, t: Translator) {
  const normalized = status.trim().toUpperCase();
  const labels: Record<string, string> = {
    NEW: t('trading.status.open'),
    PENDING: t('trading.status.pending'),
    PARTIALLY_FILLED: t('trading.status.partial'),
    FILLED: t('trading.status.filled'),
    CANCELED: t('trading.status.canceled'),
    CANCELLED: t('trading.status.canceled'),
    REJECTED: t('trading.status.rejected'),
    EXPIRED: t('trading.status.expired'),
  };
  return labels[normalized] ?? t('trading.status.updating');
}

function getContractEmptyCopy(tab: ContractRecordTab, t: Translator) {
  const copies: Record<ContractRecordTab, { title: string; hint: string }> = {
    positions: {
      title: t('trading.empty.positions'),
      hint: t('trading.empty.positionsHint'),
    },
    current: {
      title: t('trading.empty.current'),
      hint: t('trading.empty.currentHint'),
    },
    history: {
      title: t('trading.empty.history'),
      hint: t('trading.empty.historyHint'),
    },
    fills: {
      title: t('trading.empty.fills'),
      hint: t('trading.empty.fillsHint'),
    },
  };
  return copies[tab];
}

function OrderActionFeedback({
  feedback,
}: {
  feedback: NonNullable<Props['orderActionFeedback']>;
}) {
  return (
    <Text
      style={[
        styles.actionFeedback,
        feedback.tone === 'error'
          ? styles.actionFeedbackError
          : styles.actionFeedbackSuccess,
      ]}
    >
      {feedback.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  submitPressed: { opacity: 0.86, transform: [{ scale: 0.992 }] },
  card: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
  },
  tabs: {
    flexDirection: 'row',
  },
  tab: {
    flex: 1,
    minWidth: 0,
    height: 34,
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
    width: 22,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'transparent',
  },
  activeIndicator: {
    backgroundColor: colors.gold,
  },
  closeAllRow: {
    minHeight: 48,
    marginTop: 7,
    paddingHorizontal: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  closeAllHint: {
    flex: 1,
    color: colors.textSubtle,
    fontSize: 10,
  },
  closeAllButton: {
    minWidth: 86,
    height: 38,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: 'rgba(235, 87, 87, 0.1)',
  },
  closeAllButtonDisabled: {
    opacity: 0.46,
  },
  closeAllButtonText: {
    ...typography.bold,
    color: colors.red,
    fontSize: 12,
  },
  empty: {
    minHeight: 78,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: 12,
  },
  loginButton: {
    height: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
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
    minHeight: 92,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  retryButton: {
    minWidth: 100,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gold,
    backgroundColor: colors.primarySoft,
  },
  retryButtonText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  placeholder: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
  },
  placeholderHint: {
    marginTop: 5,
    color: colors.textSubtle,
    fontSize: 10,
  },
  recordEmpty: {
    minHeight: 74,
    alignItems: 'center',
    justifyContent: 'center',
  },
  records: {
    marginTop: 7,
  },
  loadMoreError: {
    marginTop: 9,
    color: colors.warning,
    fontSize: 11,
    textAlign: 'center',
  },
  loadMoreButton: {
    height: 44,
    marginTop: 8,
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
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  positionRecord: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 9,
  },
  positionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  positionIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  positionSymbol: {
    color: colors.textMuted,
    fontSize: 10,
  },
  leverageBadge: {
    minWidth: 34,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 6,
  },
  leverageText: {
    ...typography.number,
    color: colors.gold,
    fontSize: 10,
    fontWeight: '800',
  },
  positionMetrics: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 7,
  },
  positionMetric: {
    width: '33.333%',
    minWidth: 0,
    paddingRight: 6,
  },
  positionMetricLabel: {
    color: colors.textSubtle,
    fontSize: 9,
  },
  positionMetricValue: {
    ...typography.number,
    marginTop: 2,
    color: colors.text,
    fontSize: 10,
    fontWeight: '700',
  },
  positionActions: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  positionAction: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    borderWidth: 1,
  },
  closePositionAction: {
    borderColor: colors.red,
    backgroundColor: 'rgba(235, 87, 87, 0.1)',
  },
  tpSlPositionAction: {
    borderColor: colors.gold,
    backgroundColor: colors.primarySoft,
  },
  closePositionActionText: {
    ...typography.bold,
    color: colors.red,
    fontSize: 12,
  },
  tpSlPositionActionText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  recordRow: {
    minHeight: 58,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  recordMain: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recordIdentity: {
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  recordTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recordSide: {
    ...typography.bold,
    fontSize: 12,
  },
  recordMeta: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 10,
  },
  recordRight: {
    alignItems: 'flex-end',
  },
  recordValue: {
    ...typography.number,
    color: colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  recordTime: {
    marginTop: 5,
    color: colors.textSubtle,
    fontSize: 9,
  },
  recordTimeInline: {
    flexShrink: 0,
    marginTop: 0,
  },
  cancelButton: {
    minWidth: 58,
    height: 26,
    marginTop: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.gold,
    backgroundColor: colors.primarySoft,
  },
  cancelButtonDisabled: {
    opacity: 0.42,
  },
  cancelButtonText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 10,
  },
  actionFeedback: {
    marginTop: 8,
    fontSize: 11,
  },
  actionFeedbackError: {
    color: colors.warning,
  },
  actionFeedbackSuccess: {
    color: colors.green,
  },
});
