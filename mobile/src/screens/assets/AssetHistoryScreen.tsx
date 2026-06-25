import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
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
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type {RootStackParamList} from '../../navigation/types';
import {
  fetchAssetBalanceLogs,
  type AssetBalanceLogItem,
} from '../../api/assets';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
type FilterKey = 'all' | 'deposit' | 'withdraw' | 'transfer' | 'trade' | 'yield';

const pageSize = 20;
const filters: Array<{value: FilterKey; label: string; serverBizType?: string}> = [
  {value: 'all', label: '全部'},
  {value: 'deposit', label: '充值', serverBizType: 'DEPOSIT'},
  {value: 'withdraw', label: '提现', serverBizType: 'WITHDRAW'},
  {value: 'transfer', label: '划转', serverBizType: 'TRANSFER'},
  {value: 'trade', label: '交易', serverBizType: 'TRADE'},
  {value: 'yield', label: '收益'},
];

export default function AssetHistoryScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [items, setItems] = useState<AssetBalanceLogItem[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const selectedFilter = filters.find(item => item.value === filter) ?? filters[0];
  const hasMore = items.length < total;

  const loadPage = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!isLoggedIn) return;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError('');
      try {
        const response = await fetchAssetBalanceLogs(nextPage, pageSize, {
          bizType: selectedFilter.serverBizType,
        });
        const nextItems = applyClientFilter(response.items, filter);
        setItems(current => (append ? [...current, ...nextItems] : nextItems));
        setPage(response.page);
        setTotal(response.total);
      } catch (requestError) {
        if (!append) setItems([]);
        setError(toChineseError(requestError, '资金流水加载失败，请稍后重试'));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filter, isLoggedIn, selectedFilter.serverBizType],
  );

  useEffect(() => {
    if (!isLoggedIn) {
      setItems([]);
      setTotal(0);
      setError('');
      return;
    }
    loadPage(1, false).catch(() => undefined);
  }, [isLoggedIn, loadPage]);

  const filterOptions = useMemo(
    () => filters.map(item => ({value: item.value, label: item.label})),
    [],
  );

  return (
    <AppScreen>
      <ActionHeader
        title="资金流水"
        subtitle="充值、提现、划转、交易和收益记录"
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={() => loadPage(1, false)} />}
      />

      {!isLoggedIn ? (
        <AuthRequiredCard onLoginPress={() => navigation.navigate('Auth', {screen: 'Login'})} />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label="筛选"
              value={filter}
              options={filterOptions}
              onChange={value => {
                setFilter(value as FilterKey);
                setItems([]);
                setTotal(0);
              }}
            />
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
          </ActionCard>

          {loading ? (
            <StateCard title="正在加载资金流水" description="请稍候" />
          ) : items.length === 0 ? (
            <StateCard title="暂无资金流水" description="当前筛选条件下没有记录。" />
          ) : (
            <ActionCard>
              <View style={styles.listHeader}>
                <Text style={styles.cardTitle}>记录</Text>
                <Text style={styles.totalText}>共 {total} 条</Text>
              </View>
              {items.map(item => (
                <HistoryItem key={`${item.id}:${item.createdAt}`} item={item} />
              ))}
              {hasMore ? (
                <View style={styles.loadMore}>
                  <PrimaryButton
                    title={loadingMore ? '加载中...' : '加载更多'}
                    variant="secondary"
                    disabled={loadingMore}
                    onPress={() => loadPage(page + 1, true)}
                  />
                </View>
              ) : null}
            </ActionCard>
          )}
        </>
      )}
    </AppScreen>
  );
}

function HistoryItem({item}: {item: AssetBalanceLogItem}) {
  const amount = Number(item.changeAmount);
  const positive = Number.isFinite(amount) && amount > 0;
  const negative = Number.isFinite(amount) && amount < 0;
  const amountText = Number.isFinite(amount)
    ? `${positive ? '+' : ''}${formatAmount(amount)}`
    : item.changeAmount || '--';
  return (
    <View style={styles.item}>
      <View style={styles.itemTop}>
        <View style={styles.itemTitleWrap}>
          <Text style={styles.itemType}>{mapLogType(item.bizType)}</Text>
          <Text style={styles.itemMeta}>
            {item.coinSymbol || '--'} · {item.accountKey || '--'}
          </Text>
        </View>
        <Text
          style={[
            styles.amount,
            positive ? styles.amountPositive : null,
            negative ? styles.amountNegative : null,
          ]}>
          {amountText} {item.coinSymbol || ''}
        </Text>
      </View>
      <InfoRow label="时间" value={item.createdAt || '--'} />
      <InfoRow label="账户 / chain_key" value={item.accountKey || '--'} />
      <InfoRow label="备注" value={item.remark || '--'} />
    </View>
  );
}

function applyClientFilter(items: AssetBalanceLogItem[], filter: FilterKey) {
  if (filter === 'all') return items;
  return items.filter(item => {
    const type = item.bizType.toUpperCase();
    if (filter === 'transfer') return type.includes('TRANSFER');
    if (filter === 'yield') {
      return (
        type.includes('DIVIDEND') ||
        type.includes('COMMISSION') ||
        type.includes('REWARD') ||
        type.includes('INVITE')
      );
    }
    if (filter === 'deposit') return type.includes('DEPOSIT');
    if (filter === 'withdraw') return type.includes('WITHDRAW');
    if (filter === 'trade') return type.includes('TRADE') || type.includes('FEE');
    return true;
  });
}

function mapLogType(value: string) {
  const type = value.toUpperCase();
  if (type.includes('DEPOSIT')) return '充值';
  if (type.includes('WITHDRAW')) return '提现';
  if (type.includes('TRANSFER')) return '划转';
  if (type.includes('FEE')) return '手续费';
  if (type.includes('TRADE')) return '交易';
  if (type.includes('DIVIDEND')) return '分红';
  if (type.includes('INVITE') || type.includes('REWARD')) return '邀请奖励';
  if (type.includes('BD_COMMISSION')) return 'BD佣金';
  if (type.includes('ADJUST')) return '调账';
  return '其他';
}

const styles = StyleSheet.create({
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
