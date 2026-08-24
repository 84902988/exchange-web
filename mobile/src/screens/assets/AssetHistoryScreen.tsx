import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import {
  ActionCard,
  ActionHeader,
  AuthRequiredCard,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SelectChips,
  StateCard,
  formatAmount,
} from '../../components/assets/action/ActionPrimitives';
import {
  createTranslator,
  useLanguage,
  type TranslationKey,
  type Translator,
} from '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import {
  fetchAssetBalanceLogs,
  type AssetBalanceLogItem,
} from '../../api/assets';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';
import {
  isPositiveDecimalText,
  normalizeNonNegativeDecimalText,
} from '../../utils/decimalText';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
export type AssetHistoryFilterKey =
  | 'all'
  | 'deposit'
  | 'withdraw'
  | 'userTransfer'
  | 'transfer'
  | 'trade'
  | 'tradeFee'
  | 'dividend'
  | 'bdCommission'
  | 'inviteReward';

const pageSize = 20;
export const ASSET_HISTORY_FILTERS: Array<{
  value: AssetHistoryFilterKey;
  label: string;
  labelKey: TranslationKey;
  serverBizType?: string;
}> = [
  { value: 'all', label: '全部', labelKey: 'history.filter.all' },
  {
    value: 'deposit',
    label: '充值',
    labelKey: 'history.filter.deposit',
    serverBizType: 'DEPOSIT',
  },
  {
    value: 'withdraw',
    label: '提现',
    labelKey: 'history.filter.withdraw',
    serverBizType: 'WITHDRAW_SUCCESS',
  },
  {
    value: 'userTransfer',
    label: '站内转账',
    labelKey: 'history.filter.userTransfer',
    serverBizType: 'USER_TRANSFER',
  },
  {
    value: 'transfer',
    label: '账户划转',
    labelKey: 'history.filter.transfer',
    serverBizType: 'TRANSFER',
  },
  {
    value: 'trade',
    label: '交易',
    labelKey: 'history.filter.trade',
    serverBizType: 'TRADE',
  },
  {
    value: 'tradeFee',
    label: '手续费',
    labelKey: 'history.filter.tradeFee',
    serverBizType: 'TRADE_FEE',
  },
  {
    value: 'dividend',
    label: '分红',
    labelKey: 'history.filter.dividend',
    serverBizType: 'DIVIDEND',
  },
  {
    value: 'bdCommission',
    label: 'BD佣金',
    labelKey: 'history.filter.bdCommission',
    serverBizType: 'BD_COMMISSION_CREDIT',
  },
  {
    value: 'inviteReward',
    label: '邀请奖励',
    labelKey: 'history.filter.inviteReward',
    serverBizType: 'USER_INVITE_COMMISSION_CREDIT',
  },
];

export default function AssetHistoryScreen() {
  const { t } = useLanguage();
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<RouteProp<RootStackParamList, 'AssetHistory'>>();
  const { isLoggedIn } = useAuth();
  const [items, setItems] = useState<AssetBalanceLogItem[]>([]);
  const [filter, setFilter] = useState<AssetHistoryFilterKey>(
    route.params?.initialFilter ?? 'all',
  );
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const selectedFilter =
    ASSET_HISTORY_FILTERS.find(item => item.value === filter) ??
    ASSET_HISTORY_FILTERS[0];
  const hasMore = items.length < total;

  const loadPage = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!isLoggedIn) return;
      if (append && loadingMoreRef.current) return;
      const generation = append
        ? requestGenerationRef.current
        : ++requestGenerationRef.current;
      if (append) {
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError('');
      try {
        const response = await fetchAssetBalanceLogs(nextPage, pageSize, {
          bizType: selectedFilter.serverBizType,
        });
        if (generation !== requestGenerationRef.current) return;
        setItems(current =>
          append ? mergeHistoryItems(current, response.items) : response.items,
        );
        setPage(response.page);
        setTotal(response.total);
      } catch (requestError) {
        if (generation !== requestGenerationRef.current) return;
        setError(
          getHistoryError(requestError, tRef.current('history.loadFailed')),
        );
      } finally {
        if (generation === requestGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
        if (append) loadingMoreRef.current = false;
      }
    },
    [isLoggedIn, selectedFilter.serverBizType],
  );

  useEffect(() => {
    if (!isLoggedIn) {
      setItems([]);
      setTotal(0);
      setError('');
      requestGenerationRef.current += 1;
      return;
    }
    loadPage(1, false).catch(() => undefined);
    return () => {
      requestGenerationRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, [isLoggedIn, loadPage]);

  const filterOptions = useMemo(
    () =>
      ASSET_HISTORY_FILTERS.map(item => ({
        value: item.value,
        label: t(item.labelKey),
      })),
    [t],
  );

  return (
    <AppScreen scroll={false} contentStyle={styles.screen}>
      <FlatList
        contentContainerStyle={styles.listContent}
        data={isLoggedIn && !loading ? items : []}
        initialNumToRender={8}
        keyExtractor={item => `${item.id}:${item.createdAt}`}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        maxToRenderPerBatch={8}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item }) => <HistoryItem item={item} />}
        showsVerticalScrollIndicator={false}
        updateCellsBatchingPeriod={40}
        windowSize={7}
        ListHeaderComponent={
          <>
            <ActionHeader
              title={t('history.title')}
              subtitle={t('history.subtitle')}
              backAccessibilityLabel={t('common.back')}
              onBack={() => navigation.goBack()}
              right={
                <RefreshButton
                  accessibilityLabel={t('history.refreshA11y')}
                  disabled={loading}
                  onPress={() => loadPage(1, false)}
                />
              }
            />
            {!isLoggedIn ? (
              <AuthRequiredCard
                actionTitle={t('history.goLogin')}
                description={t('history.loginDescription')}
                title={t('history.loginTitle')}
                onLoginPress={() =>
                  navigation.navigate('Auth', { screen: 'Login' })
                }
              />
            ) : (
              <>
                <ActionCard>
                  <SelectChips
                    label={t('history.filter')}
                    value={filter}
                    options={filterOptions}
                    onChange={value => {
                      setFilter(value as AssetHistoryFilterKey);
                      setItems([]);
                      setTotal(0);
                    }}
                  />
                  {error ? (
                    <InlineNotice tone="red">{error}</InlineNotice>
                  ) : null}
                </ActionCard>
                {loading ? (
                  <StateCard
                    title={t('history.loading')}
                    description={t('common.pleaseWait')}
                  />
                ) : items.length === 0 ? (
                  <StateCard
                    title={t('history.empty')}
                    description={t('history.emptyDescription')}
                  />
                ) : (
                  <View style={styles.listHeader}>
                    <Text style={styles.cardTitle}>{t('history.records')}</Text>
                    <Text style={styles.totalText}>
                      {t('history.total', { count: total })}
                    </Text>
                  </View>
                )}
              </>
            )}
          </>
        }
        ListFooterComponent={
          isLoggedIn && !loading && items.length > 0 && hasMore ? (
            <View style={styles.loadMore}>
              <PrimaryButton
                title={
                  loadingMore ? t('history.loadingMore') : t('history.loadMore')
                }
                variant="secondary"
                disabled={loadingMore}
                onPress={() => loadPage(page + 1, true)}
              />
            </View>
          ) : null
        }
      />
    </AppScreen>
  );
}

function HistoryItem({ item }: { item: AssetBalanceLogItem }) {
  const { t } = useLanguage();
  const rawAmount = item.changeAmount.trim();
  const negative = rawAmount.startsWith('-');
  const unsignedAmount = rawAmount.replace(/^[+-]/, '');
  const amountValid = normalizeNonNegativeDecimalText(unsignedAmount) !== null;
  const positive = !negative && isPositiveDecimalText(unsignedAmount);
  const amountText = amountValid
    ? `${positive ? '+' : ''}${formatAmount(item.changeAmount)}`
    : '--';
  return (
    <View style={styles.item}>
      <View style={styles.itemTop}>
        <View style={styles.itemTitleWrap}>
          <Text style={styles.itemType}>{mapLogType(item.bizType, t)}</Text>
          <Text style={styles.itemMeta}>
            {item.coinSymbol || '--'} · {mapAccountLabel(item.accountKey, t)}
          </Text>
        </View>
        <Text
          style={[
            styles.amount,
            positive ? styles.amountPositive : null,
            negative ? styles.amountNegative : null,
          ]}
        >
          {amountText} {item.coinSymbol || ''}
        </Text>
      </View>
      <InfoRow label={t('history.time')} value={item.createdAt || '--'} />
      <InfoRow
        label={t('history.account')}
        value={mapAccountLabel(item.accountKey, t)}
      />
      <InfoRow
        label={t('history.remark')}
        value={formatAssetLogRemark(item.remark, item.bizType, t)}
      />
    </View>
  );
}

function mergeHistoryItems(
  current: AssetBalanceLogItem[],
  next: AssetBalanceLogItem[],
) {
  const byId = new Map(current.map(item => [item.id, item]));
  next.forEach(item => byId.set(item.id, item));
  return Array.from(byId.values());
}

const logTypeKeys: Record<string, TranslationKey> = {
  FREEZE: 'history.type.freeze',
  UNFREEZE: 'history.type.unfreeze',
  TRANSFER_IN: 'history.type.transferIn',
  TRANSFER_OUT: 'history.type.transferOut',
  DEPOSIT: 'history.type.depositReceived',
  CHAIN_DEPOSIT: 'history.type.depositReceived',
  DEPOSIT_CONFIRM: 'history.type.depositReceived',
  WITHDRAW: 'history.type.withdrawFreeze',
  WITHDRAW_FREEZE: 'history.type.withdrawFreeze',
  WITHDRAW_FEE_FREEZE: 'history.type.withdrawFeeFreeze',
  WITHDRAW_SEND: 'history.type.withdrawSend',
  WITHDRAW_SUCCESS: 'history.type.withdrawSuccess',
  WITHDRAW_FEE_SUCCESS: 'history.type.withdrawFeeDeducted',
  WITHDRAW_UNFREEZE: 'history.type.withdrawUnfreeze',
  WITHDRAW_FEE_UNFREEZE: 'history.type.withdrawFeeUnfreeze',
  WITHDRAW_CANCEL: 'history.type.withdrawCancel',
  WITHDRAW_FEE_CANCEL: 'history.type.withdrawFeeCancel',
  WITHDRAW_FAILED: 'history.type.withdrawFailed',
  TRADE_BUY: 'history.type.spotBuy',
  SPOT_BUY: 'history.type.spotBuy',
  TRADE_SELL: 'history.type.spotSell',
  SPOT_SELL: 'history.type.spotSell',
  TRADE_FREEZE: 'history.type.tradeFreeze',
  TRADE_UNFREEZE: 'history.type.tradeUnfreeze',
  TRADE_FEE_DEBIT: 'history.type.tradeFeeDebit',
  TRADE_FEE_CREDIT: 'history.type.tradeFeeCredit',
  TRANSFER: 'history.type.accountTransfer',
  USER_TRANSFER: 'history.type.userTransfer',
  USER_TRANSFER_OUT: 'history.type.userTransferOut',
  USER_TRANSFER_IN: 'history.type.userTransferIn',
  ACCOUNT_TRANSFER: 'history.type.accountTransfer',
  PLATFORM_ADJUST: 'history.type.accountAdjustment',
  ADMIN_ADJUST: 'history.type.accountAdjustment',
  MANUAL_ADJUST: 'history.type.accountAdjustment',
  DIVIDEND_PAYOUT: 'history.type.dividendPaid',
  BD_COMMISSION_PAYOUT: 'history.type.bdCommissionPaid',
  USER_INVITE_COMMISSION_PAYOUT: 'history.type.inviteRewardPaid',
  INVITE_REWARD: 'history.type.inviteReward',
  STOCK_TOKEN_LOCK: 'history.type.stockTokenLock',
  STOCK_TOKEN_RELEASE: 'history.type.stockTokenRelease',
  STOCK_TOKEN_CONVERT: 'history.type.stockTokenConvert',
  CONTRACT_TRANSFER_IN: 'history.type.contractTransferIn',
  CONTRACT_TRANSFER_OUT: 'history.type.contractTransferOut',
  CONTRACT_OPEN_MARGIN: 'history.type.contractOpenMargin',
  CONTRACT_MARGIN_RELEASE: 'history.type.contractMarginRelease',
  CONTRACT_REALIZED_PNL: 'history.type.contractRealizedPnl',
  CONTRACT_LIQUIDATION: 'history.type.contractLiquidation',
  LIQUIDATION_ZERO: 'history.type.liquidationZero',
  CONTRACT_TRANSFER: 'history.type.transfer',
  REALIZED_PNL: 'history.type.realizedPnl',
  OPEN_MARGIN_FREEZE: 'history.type.openMarginFreeze',
  OPEN_MARGIN_USED: 'history.type.openMarginUsed',
  OPEN_FEE: 'history.type.openFee',
  CLOSE_RELEASE: 'history.type.closeRelease',
  CONTRACT_SPREAD_FEE: 'history.type.contractFee',
  MATCHING_DIRTY_ORDER_RELEASE: 'history.type.abnormalRelease',
  RCB_LOCK: 'history.type.rcbLock',
  DIVIDEND_CREDIT: 'history.type.dividendCredit',
  DIVIDEND_DEBIT: 'history.type.dividendDebit',
  BD_COMMISSION_CREDIT: 'history.type.bdCredit',
  BD_COMMISSION_DEBIT: 'history.type.bdDebit',
  USER_INVITE_COMMISSION_CREDIT: 'history.type.inviteCredit',
  USER_INVITE_COMMISSION_DEBIT: 'history.type.inviteDebit',
};

export function mapLogType(
  value: string,
  t: Translator = createTranslator('zh-CN'),
) {
  const type = value.toUpperCase();
  const exactKey = logTypeKeys[type];
  if (exactKey) return t(exactKey);
  if (type.includes('DEPOSIT')) return t('history.type.deposit');
  if (type.includes('WITHDRAW')) return t('history.type.withdraw');
  if (type.includes('USER_TRANSFER')) return t('history.type.userTransfer');
  if (type.includes('TRANSFER')) return t('history.type.transfer');
  if (type.includes('FEE')) return t('history.type.fee');
  if (type.includes('TRADE')) return t('history.type.trade');
  if (type.includes('DIVIDEND')) return t('history.type.dividend');
  if (type.includes('INVITE') || type.includes('REWARD')) {
    return t('history.type.inviteReward');
  }
  if (type.includes('BD_COMMISSION')) return t('history.type.bdCommission');
  if (type.includes('ADJUST')) return t('history.type.adjustment');
  return t('history.type.other');
}

const remarkKeys: Record<string, TranslationKey> = {
  'liquidation realized pnl': 'history.remark.liquidationPnl',
  'liquidation margin release': 'history.remark.liquidationMarginRelease',
  'liquidation position balance zeroed': 'history.remark.liquidationSettlement',
  'contract close spread fee': 'history.remark.closeFee',
  'contract open spread fee': 'history.remark.openFee',
  'contract close margin release': 'history.remark.closeMarginRelease',
  'close realized pnl': 'history.remark.closePnl',
  'contract margin freeze': 'history.remark.contractMarginFreeze',
  'contract margin release': 'history.remark.contractMarginRelease',
  'open limit order margin frozen': 'history.remark.limitMarginFreeze',
  'cancel contract limit order release frozen margin':
    'history.remark.cancelMarginRelease',
  'order created': 'history.remark.orderFreeze',
  'order canceled': 'history.remark.orderCancel',
  'order cancelled': 'history.remark.orderCancel',
  'trade fee': 'history.remark.tradeFee',
  'withdraw freeze': 'history.remark.withdrawFreeze',
  'withdraw unfreeze': 'history.remark.withdrawUnfreeze',
  'withdraw fee freeze': 'history.remark.withdrawFeeFreeze',
  'deposit confirmed': 'history.remark.depositConfirmed',
  'cancel unfreeze': 'history.remark.orderCancel',
};

export function formatAssetLogRemark(
  rawRemark: string,
  bizType: string,
  t: Translator = createTranslator('zh-CN'),
) {
  const remark = rawRemark.trim();
  if (!remark) return '--';
  if (/[一-鿿]/.test(remark)) return remark;

  const normalized = remark
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[;:,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const exactKey = remarkKeys[normalized];
  if (exactKey) return t(exactKey);
  const prefix = Object.entries(remarkKeys).find(([key]) =>
    normalized.startsWith(`${key} `),
  );
  if (prefix) return t(prefix[1]);

  const typeLabel = mapLogType(bizType, t);
  return typeLabel === t('history.type.other') ? '--' : typeLabel;
}

export function mapAccountLabel(
  value: string,
  t: Translator = createTranslator('zh-CN'),
) {
  const account = value.trim().toLowerCase();
  if (account === 'funding') return t('assets.account.funding');
  if (account === 'spot') return t('assets.account.spot');
  if (account === 'contract') return t('assets.account.contract');
  return t('assets.account.other');
}

function getHistoryError(error: unknown, fallback: string) {
  if (error instanceof Error && /[一-鿿]/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { paddingBottom: 16 },
  listHeader: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  cardTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
  },
  totalText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  item: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    padding: 10,
  },
  itemTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  itemTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  itemType: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  itemMeta: {
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 11,
  },
  amount: {
    ...typography.number,
    ...typography.bold,
    flexShrink: 1,
    color: colors.text,
    fontSize: 13,
    textAlign: 'right',
  },
  amountPositive: {
    color: colors.green,
  },
  amountNegative: {
    color: colors.red,
  },
  loadMore: {
    marginTop: 12,
  },
});
