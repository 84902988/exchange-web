import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BadgeCheck, ShieldCheck} from 'lucide-react-native';
import AppScreen from '../../components/common/AppScreen';
import AssetAccountDistribution, {
  type AssetDistributionItem,
} from '../../components/assets/AssetAccountDistribution';
import AssetBdSummary from '../../components/assets/AssetBdSummary';
import AssetCoinList from '../../components/assets/AssetCoinList';
import AssetEmptyState from '../../components/assets/AssetEmptyState';
import AssetInviteSummary from '../../components/assets/AssetInviteSummary';
import AssetOverviewCard from '../../components/assets/AssetOverviewCard';
import AssetQuickActions from '../../components/assets/AssetQuickActions';
import AssetTopTabs, {
  type AssetTabKey,
} from '../../components/assets/AssetTopTabs';
import type {RootStackParamList} from '../../navigation/types';
import {
  estimateUsdtValue,
  fetchAssetAccountBalances,
  fetchAssetBdOverview,
  fetchAssetInviteOverview,
  formatAssetAmountText,
  formatAssetNumber,
  type AssetAccountBalance,
  type AssetBdOverview,
  type AssetInviteOverview,
} from '../../api/assets';
import {
  fetchContractAccountSummary,
  type ContractAccountSummary,
} from '../../api/contract';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

type AccountKey = 'funding' | 'spot' | 'contract';

const accountMeta: Array<{
  key: AccountKey;
  label: string;
  color: string;
}> = [
  {key: 'funding', label: '资金账户', color: colors.gold},
  {key: 'spot', label: '现货账户', color: colors.green},
  {key: 'contract', label: '合约账户', color: '#9B7CFF'},
];

export default function AssetsScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [activeTab, setActiveTab] = useState<AssetTabKey>('overview');
  const [hidden, setHidden] = useState(false);
  const [balances, setBalances] = useState<AssetAccountBalance[]>([]);
  const [contractSummary, setContractSummary] =
    useState<ContractAccountSummary | null>(null);
  const [inviteOverview, setInviteOverview] = useState<AssetInviteOverview | null>(
    null,
  );
  const [bdOverview, setBdOverview] = useState<AssetBdOverview | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [contractError, setContractError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [bdError, setBdError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openLogin = useCallback(() => {
    navigation.navigate('Auth', {screen: 'Login'});
  }, [navigation]);

  const loadPrivateData = useCallback(async () => {
    if (!isLoggedIn) {
      setBalances([]);
      setContractSummary(null);
      setInviteOverview(null);
      setBdOverview(null);
      setAssetError(null);
      setContractError(null);
      setInviteError(null);
      setBdError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const [assetResult, contractResult, inviteResult, bdResult] =
      await Promise.allSettled([
        fetchAssetAccountBalances(),
        fetchContractAccountSummary(),
        fetchAssetInviteOverview(),
        fetchAssetBdOverview(),
      ]);

    if (assetResult.status === 'fulfilled') {
      setBalances(assetResult.value);
      setAssetError(null);
    } else {
      setBalances([]);
      setAssetError(getErrorMessage(assetResult.reason, '资产数据加载失败'));
    }

    if (contractResult.status === 'fulfilled') {
      setContractSummary(contractResult.value);
      setContractError(null);
    } else {
      setContractSummary(null);
      setContractError(getErrorMessage(contractResult.reason, '合约账户加载失败'));
    }

    if (inviteResult.status === 'fulfilled') {
      setInviteOverview(inviteResult.value);
      setInviteError(null);
    } else {
      setInviteOverview(null);
      setInviteError(getErrorMessage(inviteResult.reason, '邀请概览加载失败'));
    }

    if (bdResult.status === 'fulfilled') {
      setBdOverview(bdResult.value);
      setBdError(null);
    } else {
      setBdOverview(null);
      setBdError(getErrorMessage(bdResult.reason, '代理概览加载失败'));
    }

    setLoading(false);
  }, [isLoggedIn]);

  useEffect(() => {
    loadPrivateData();
  }, [loadPrivateData]);

  const accountTotals = useMemo(() => buildAccountTotals(balances), [balances]);
  const totalUsdt = useMemo(
    () => accountMeta.reduce((sum, item) => sum + accountTotals[item.key], 0),
    [accountTotals],
  );
  const distributionItems = useMemo<AssetDistributionItem[]>(
    () =>
      accountMeta.map(item => ({
        key: item.key,
        label: item.label,
        value: accountTotals[item.key],
        color: item.color,
      })),
    [accountTotals],
  );
  const fundingRows = useMemo(
    () => filterAccountRows(balances, 'funding'),
    [balances],
  );
  const spotRows = useMemo(() => filterAccountRows(balances, 'spot'), [balances]);
  const contractRows = useMemo(
    () => filterAccountRows(balances, 'contract'),
    [balances],
  );

  const handleQuickAction = useCallback((label: string) => {
    Alert.alert(label, '该入口已预留，V1 暂不进入真实充值、提现、划转或流水流程。');
  }, []);

  return (
    <AppScreen>
      <AssetTopTabs activeKey={activeTab} onChange={setActiveTab} />
      <AssetOverviewCard
        hidden={hidden}
        loading={loading}
        totalUsdt={isLoggedIn ? totalUsdt : 0}
        onToggleHidden={() => setHidden(current => !current)}
      />
      <AssetQuickActions onActionPress={handleQuickAction} />
      {!isLoggedIn ? (
        <View style={styles.loginCard}>
          <Text style={styles.loginTitle}>登录后查看完整资产</Text>
          <Text style={styles.loginDesc}>
            资产、邀请和代理数据均在登录后读取，未登录不会请求私有接口。
          </Text>
          <Pressable style={styles.loginButton} onPress={openLogin}>
            <Text style={styles.loginText}>登录</Text>
          </Pressable>
        </View>
      ) : assetError ? (
        <Text style={styles.error}>{assetError}</Text>
      ) : null}

      {!isLoggedIn ? null : (
        <>

      {activeTab === 'overview' ? (
        <OverviewContent
          distributionItems={distributionItems}
          fundingRows={fundingRows}
          hidden={hidden}
          spotRows={spotRows}
          contractRows={contractRows}
        />
      ) : null}

      {activeTab === 'spot' ? (
        <AssetCoinList
          emptyTitle="暂无现货资产"
          hidden={hidden}
          items={spotRows}
        />
      ) : null}

      {activeTab === 'contract' ? (
        <ContractContent
          account={contractSummary}
          error={contractError}
          hidden={hidden}
          rows={contractRows}
        />
      ) : null}

      {activeTab === 'invite' ? (
        <AssetInviteSummary
          error={inviteError}
          isLoggedIn={isLoggedIn}
          loading={loading}
          overview={inviteOverview}
          onLoginPress={openLogin}
        />
      ) : null}

      {activeTab === 'bd' ? (
        <AssetBdSummary
          error={bdError}
          isLoggedIn={isLoggedIn}
          loading={loading}
          overview={bdOverview}
          onLoginPress={openLogin}
        />
      ) : null}
        </>
      )}
    </AppScreen>
  );
}

function OverviewContent({
  distributionItems,
  fundingRows,
  spotRows,
  contractRows,
  hidden,
}: {
  distributionItems: AssetDistributionItem[];
  fundingRows: AssetAccountBalance[];
  spotRows: AssetAccountBalance[];
  contractRows: AssetAccountBalance[];
  hidden: boolean;
}) {
  return (
    <>
      <AssetAccountDistribution hidden={hidden} items={distributionItems} />
      <View style={styles.summaryCard}>
        <Text style={styles.sectionTitle}>账户汇总</Text>
        <AccountSummaryRow hidden={hidden} label="资金账户" rows={fundingRows} />
        <AccountSummaryRow hidden={hidden} label="现货账户" rows={spotRows} />
        <AccountSummaryRow hidden={hidden} label="合约账户" rows={contractRows} />
      </View>
      <SecurityCards />
    </>
  );
}

function ContractContent({
  account,
  rows,
  hidden,
  error,
}: {
  account: ContractAccountSummary | null;
  rows: AssetAccountBalance[];
  hidden: boolean;
  error?: string | null;
}) {
  if (error) {
    return <AssetEmptyState title="合约账户暂不可用" description={error} />;
  }

  if (!account && rows.length === 0) {
    return <AssetEmptyState title="暂无合约资产" />;
  }

  return (
    <>
      <View style={styles.summaryCard}>
        <Text style={styles.sectionTitle}>合约账户摘要</Text>
        <MetricRow
          hidden={hidden}
          label="保证金余额"
          value={formatContractMetric(account?.equity)}
        />
        <MetricRow
          hidden={hidden}
          label="可用保证金"
          value={formatContractMetric(account?.availableMargin)}
        />
        <MetricRow
          hidden={hidden}
          label="未实现盈亏"
          value={formatContractMetric(account?.unrealizedPnl)}
        />
        <MetricRow
          hidden={hidden}
          label="已实现盈亏"
          value={formatContractMetric(account?.realizedPnl)}
        />
      </View>
      <AssetCoinList emptyTitle="暂无合约资产" hidden={hidden} items={rows} />
    </>
  );
}

function SecurityCards() {
  return (
    <View style={styles.securityGrid}>
      <View style={styles.securityCard}>
        <ShieldCheck color={colors.gold} size={22} strokeWidth={2.2} />
        <Text style={styles.securityTitle}>资金安全</Text>
        <Text style={styles.securityText}>
          多账户分层管理，关键资金操作配合风控校验，守护每一次资产流转。
        </Text>
      </View>
      <View style={styles.securityCard}>
        <BadgeCheck color={colors.green} size={22} strokeWidth={2.2} />
        <Text style={styles.securityTitle}>储备金证明</Text>
        <Text style={styles.securityText}>
          平台持续完善储备与风险说明，让账户资产更透明、更可追踪。
        </Text>
      </View>
    </View>
  );
}

function AccountSummaryRow({
  label,
  rows,
  hidden,
}: {
  label: string;
  rows: AssetAccountBalance[];
  hidden: boolean;
}) {
  const value = rows.reduce((sum, item) => sum + (estimateUsdtValue(item) ?? 0), 0);
  const coinCount = rows.filter(item => (item.available ?? 0) + (item.frozen ?? 0) > 0)
    .length;
  return (
    <View style={styles.metricRow}>
      <View>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricMeta}>{coinCount} 个资产</Text>
      </View>
      <Text style={styles.metricValue}>
        {hidden ? '******' : `${formatAssetNumber(value, 2)} USDT`}
      </Text>
    </View>
  );
}

function MetricRow({
  label,
  value,
  hidden,
}: {
  label: string;
  value: string;
  hidden: boolean;
}) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{hidden ? '******' : value}</Text>
    </View>
  );
}

function buildAccountTotals(items: AssetAccountBalance[]) {
  return accountMeta.reduce<Record<AccountKey, number>>(
    (totals, account) => {
      totals[account.key] = items
        .filter(item => item.accountKey.toLowerCase() === account.key)
        .reduce((sum, item) => sum + (estimateUsdtValue(item) ?? 0), 0);
      return totals;
    },
    {funding: 0, spot: 0, contract: 0},
  );
}

function filterAccountRows(items: AssetAccountBalance[], accountKey: AccountKey) {
  return items
    .filter(item => item.accountKey.toLowerCase() === accountKey)
    .sort((a, b) => {
      const aTotal = (a.available ?? 0) + (a.frozen ?? 0);
      const bTotal = (b.available ?? 0) + (b.frozen ?? 0);
      if (bTotal !== aTotal) return bTotal - aTotal;
      return a.symbol.localeCompare(b.symbol);
    });
}

function formatContractMetric(value: number | null | undefined) {
  return formatAssetAmountText(value, 'USDT', 2);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const styles = StyleSheet.create({
  loginCard: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.24)',
    backgroundColor: 'rgba(214,168,50,0.1)',
    padding: 12,
  },
  loginTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  loginDesc: {
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  loginButton: {
    height: 32,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.gold,
    marginTop: 11,
    paddingHorizontal: 18,
  },
  loginText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 12,
  },
  error: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    color: colors.gold,
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  summaryCard: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  sectionTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
    marginBottom: 6,
  },
  metricRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 10,
  },
  metricLabel: {
    ...typography.bold,
    color: colors.text,
    fontSize: 12,
  },
  metricMeta: {
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 10,
  },
  metricValue: {
    ...typography.number,
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'right',
  },
  securityGrid: {
    marginTop: 12,
    gap: 10,
  },
  securityCard: {
    minHeight: 108,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  securityTitle: {
    ...typography.bold,
    marginTop: 10,
    color: colors.text,
    fontSize: 14,
  },
  securityText: {
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
});
