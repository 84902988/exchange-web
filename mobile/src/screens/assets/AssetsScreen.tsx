import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type CompositeNavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ChartNoAxesCombined, Coins } from 'lucide-react-native';
import AppScreen from '../../components/common/AppScreen';
import AssetAccountHero from '../../components/assets/AssetAccountHero';
import AssetAccountDistribution, {
  type AssetDistributionItem,
} from '../../components/assets/AssetAccountDistribution';
import AssetBdTeamMembers from '../../components/assets/AssetBdTeamMembers';
import AssetBdSummary from '../../components/assets/AssetBdSummary';
import AssetCoinList from '../../components/assets/AssetCoinList';
import AssetEmptyState from '../../components/assets/AssetEmptyState';
import AssetInviteSummary from '../../components/assets/AssetInviteSummary';
import AssetInviteCommissionRecords from '../../components/assets/AssetInviteCommissionRecords';
import AssetInvitedFriends from '../../components/assets/AssetInvitedFriends';
import AssetOverviewCard from '../../components/assets/AssetOverviewCard';
import AssetQuickActions, {
  type AssetQuickActionKey,
} from '../../components/assets/AssetQuickActions';
import AssetStockTokenEntry from '../../components/assets/AssetStockTokenEntry';
import AssetTopTabs, {
  type AssetTabKey,
} from '../../components/assets/AssetTopTabs';
import {
  createTranslator,
  useLanguage,
  type TranslationKey,
  type Translator,
} from '../../i18n';
import type {
  MainTabParamList,
  RootStackParamList,
} from '../../navigation/types';
import {
  createAssetBdApplication,
  fetchAssetBdApplication,
  fetchAssetBdOverview,
  fetchAssetInviteOverview,
  formatAssetAmountText,
  formatAssetNumber,
  type AssetBdApplication,
  type AssetBdOverview,
  type AssetInviteOverview,
  type CreateAssetBdApplicationInput,
} from '../../api/assets';
import {
  fetchContractAccountSummary,
  type ContractAccountSummary,
} from '../../api/contract';
import {
  fetchInvitedFriends,
  filterInvitedFriendsBySource,
  type InvitedFriend,
} from '../../api/invite';
import {
  getAssetAccountValuation,
  type AssetAccountValuation,
  type AssetValuationRow,
} from '../../services/assetSnapshot';
import {
  getAssetSnapshotUserId,
  useAssetSnapshot,
} from '../../hooks/useAssetSnapshot';
import { useMarketScreenActive } from '../../hooks/useMarketScreenActive';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

type AssetsNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Assets'>,
  NativeStackNavigationProp<RootStackParamList>
>;

type AccountKey = 'funding' | 'spot' | 'contract';

const guestTabCopyKeys: Record<
  AssetTabKey,
  {
    eyebrow: TranslationKey;
    title: TranslationKey;
    description: TranslationKey;
  }
> = {
  overview: {
    eyebrow: 'assets.guest.overview.eyebrow',
    title: 'assets.guest.overview.title',
    description: 'assets.guest.overview.description',
  },
  spot: {
    eyebrow: 'assets.guest.spot.eyebrow',
    title: 'assets.guest.spot.title',
    description: 'assets.guest.spot.description',
  },
  contract: {
    eyebrow: 'assets.guest.contract.eyebrow',
    title: 'assets.guest.contract.title',
    description: 'assets.guest.contract.description',
  },
  invite: {
    eyebrow: 'assets.guest.invite.eyebrow',
    title: 'assets.guest.invite.title',
    description: 'assets.guest.invite.description',
  },
  bd: {
    eyebrow: 'assets.guest.bd.eyebrow',
    title: 'assets.guest.bd.title',
    description: 'assets.guest.bd.description',
  },
};

const accountMeta: Array<{
  key: AccountKey;
  labelKey: TranslationKey;
  color: string;
}> = [
  { key: 'funding', labelKey: 'assets.account.funding', color: colors.gold },
  { key: 'spot', labelKey: 'assets.account.spot', color: colors.green },
  { key: 'contract', labelKey: 'assets.account.contract', color: '#9B7CFF' },
];
const emptyValuationRows: AssetValuationRow[] = [];

export default function AssetsScreen() {
  const { t } = useLanguage();
  const navigation = useNavigation<AssetsNavigation>();
  const route = useRoute<RouteProp<MainTabParamList, 'Assets'>>();
  const { isLoggedIn, loading: authLoading, user } = useAuth();
  const userId = getAssetSnapshotUserId(user?.id);
  const screenActive = useMarketScreenActive();
  const assetSnapshotState = useAssetSnapshot();
  const snapshot = assetSnapshotState.snapshot;
  const [activeTab, setActiveTab] = useState<AssetTabKey>('overview');
  const [hidden, setHidden] = useState(false);
  const [contractSummary, setContractSummary] =
    useState<ContractAccountSummary | null>(null);
  const [inviteOverview, setInviteOverview] =
    useState<AssetInviteOverview | null>(null);
  const [invitedFriends, setInvitedFriends] = useState<InvitedFriend[]>([]);
  const [bdTeamMembers, setBdTeamMembers] = useState<InvitedFriend[]>([]);
  const [bdOverview, setBdOverview] = useState<AssetBdOverview | null>(null);
  const [bdApplication, setBdApplication] = useState<AssetBdApplication | null>(
    null,
  );
  const [contractError, setContractError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitedFriendsError, setInvitedFriendsError] = useState<string | null>(
    null,
  );
  const [bdTeamMembersError, setBdTeamMembersError] = useState<string | null>(
    null,
  );
  const [bdError, setBdError] = useState<string | null>(null);
  const [bdApplicationError, setBdApplicationError] = useState<string | null>(
    null,
  );
  const [bdSubmitError, setBdSubmitError] = useState<string | null>(null);
  const [bdSubmitSuccess, setBdSubmitSuccess] = useState<string | null>(null);
  const [bdSubmitting, setBdSubmitting] = useState(false);
  const [secondaryLoading, setSecondaryLoading] = useState<
    Record<'contract' | 'invite' | 'bd', boolean>
  >({ contract: false, invite: false, bd: false });
  const privateGenerationRef = useRef({ contract: 0, invite: 0, bd: 0 });
  const bdSubmitLockRef = useRef(false);
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    const requestedSection = route.params?.section;
    if (requestedSection) {
      setActiveTab(requestedSection);
      navigation.setParams({ section: undefined });
    }
  }, [navigation, route.params?.section]);

  const openLogin = useCallback(() => {
    navigation.navigate('Auth', { screen: 'Login' });
  }, [navigation]);

  const loadPrivateData = useCallback(
    async (tab: AssetTabKey) => {
      if (!userId || authLoading) {
        setContractSummary(null);
        setInviteOverview(null);
        setInvitedFriends([]);
        setBdTeamMembers([]);
        setBdOverview(null);
        setBdApplication(null);
        setContractError(null);
        setInviteError(null);
        setInvitedFriendsError(null);
        setBdTeamMembersError(null);
        setBdError(null);
        setBdApplicationError(null);
        setBdSubmitError(null);
        setBdSubmitSuccess(null);
        setBdSubmitting(false);
        setSecondaryLoading({ contract: false, invite: false, bd: false });
        return;
      }

      if (tab !== 'contract' && tab !== 'invite' && tab !== 'bd') return;

      const generation = ++privateGenerationRef.current[tab];
      setSecondaryLoading(current => ({ ...current, [tab]: true }));
      try {
        if (tab === 'contract') {
          const result = await fetchContractAccountSummary();
          if (generation !== privateGenerationRef.current.contract) return;
          setContractSummary(result);
          setContractError(null);
        } else if (tab === 'invite') {
          const [overviewResult, friendsResult] = await Promise.allSettled([
            fetchAssetInviteOverview(),
            fetchInvitedFriends(),
          ]);
          if (generation !== privateGenerationRef.current.invite) return;
          if (overviewResult.status === 'fulfilled') {
            setInviteOverview(overviewResult.value);
            setInviteError(null);
          } else {
            setInviteOverview(null);
            setInviteError(
              getErrorMessage(
                overviewResult.reason,
                tRef.current('invite.loadOverviewFailed'),
              ),
            );
          }
          if (friendsResult.status === 'fulfilled') {
            setInvitedFriends(
              filterInvitedFriendsBySource(
                friendsResult.value.items,
                'USER_INVITE',
              ),
            );
            setInvitedFriendsError(null);
          } else {
            setInvitedFriends([]);
            setInvitedFriendsError(
              getErrorMessage(
                friendsResult.reason,
                tRef.current('invite.loadFriendsFailed'),
              ),
            );
          }
        } else {
          const [overviewResult, applicationResult, teamResult] =
            await Promise.allSettled([
              fetchAssetBdOverview(),
              fetchAssetBdApplication(),
              fetchInvitedFriends(),
            ]);
          if (generation !== privateGenerationRef.current.bd) return;
          if (overviewResult.status === 'fulfilled') {
            setBdOverview(overviewResult.value);
            setBdError(null);
          } else {
            setBdOverview(null);
            setBdError(
              getErrorMessage(
                overviewResult.reason,
                tRef.current('bd.loadFailed'),
              ),
            );
          }
          if (applicationResult.status === 'fulfilled') {
            setBdApplication(applicationResult.value);
            setBdApplicationError(null);
          } else {
            setBdApplication(null);
            setBdApplicationError(
              getErrorMessage(
                applicationResult.reason,
                tRef.current('bd.applicationLoadFailed'),
              ),
            );
          }
          if (teamResult.status === 'fulfilled') {
            setBdTeamMembers(
              filterInvitedFriendsBySource(teamResult.value.items, 'BD'),
            );
            setBdTeamMembersError(null);
          } else {
            setBdTeamMembers([]);
            setBdTeamMembersError(
              getErrorMessage(
                teamResult.reason,
                tRef.current('bd.teamLoadFailed'),
              ),
            );
          }
        }
      } catch (error) {
        if (generation !== privateGenerationRef.current[tab]) return;
        if (tab === 'contract') {
          setContractSummary(null);
          setContractError(
            getErrorMessage(error, tRef.current('assets.contract.loadFailed')),
          );
        } else if (tab === 'invite') {
          setInviteOverview(null);
          setInvitedFriends([]);
          setInviteError(
            getErrorMessage(error, tRef.current('invite.loadOverviewFailed')),
          );
          setInvitedFriendsError(
            getErrorMessage(error, tRef.current('invite.loadFriendsFailed')),
          );
        } else {
          setBdOverview(null);
          setBdApplication(null);
          setBdTeamMembers([]);
          setBdError(getErrorMessage(error, tRef.current('bd.loadFailed')));
          setBdApplicationError(
            getErrorMessage(error, tRef.current('bd.applicationLoadFailed')),
          );
          setBdTeamMembersError(
            getErrorMessage(error, tRef.current('bd.teamLoadFailed')),
          );
        }
      } finally {
        if (generation === privateGenerationRef.current[tab]) {
          setSecondaryLoading(current => ({ ...current, [tab]: false }));
        }
      }
    },
    [authLoading, userId],
  );

  useEffect(() => {
    const privateGenerations = privateGenerationRef.current;
    if (!screenActive) {
      privateGenerations.contract += 1;
      privateGenerations.invite += 1;
      privateGenerations.bd += 1;
      setSecondaryLoading({ contract: false, invite: false, bd: false });
      return;
    }
    loadPrivateData(activeTab).catch(() => undefined);
    return () => {
      if (
        activeTab === 'contract' ||
        activeTab === 'invite' ||
        activeTab === 'bd'
      ) {
        privateGenerations[activeTab] += 1;
      }
    };
  }, [activeTab, loadPrivateData, screenActive]);

  const retryActiveTab = useCallback(() => {
    loadPrivateData(activeTab).catch(() => undefined);
  }, [activeTab, loadPrivateData]);

  const submitBdApplication = useCallback(
    async (input: CreateAssetBdApplicationInput) => {
      if (bdSubmitLockRef.current || bdSubmitting) return;
      bdSubmitLockRef.current = true;
      setBdSubmitting(true);
      setBdSubmitError(null);
      setBdSubmitSuccess(null);
      try {
        const result = await createAssetBdApplication(input);
        setBdApplication(result);
        setBdApplicationError(null);
        setBdSubmitSuccess(tRef.current('bd.applicationSubmitted'));
      } catch (error) {
        setBdSubmitError(
          getErrorMessage(error, tRef.current('bd.applicationSubmitFailed')),
        );
        await loadPrivateData('bd').catch(() => undefined);
      } finally {
        bdSubmitLockRef.current = false;
        setBdSubmitting(false);
      }
    },
    [bdSubmitting, loadPrivateData],
  );

  const valuationRows = snapshot?.rows ?? emptyValuationRows;
  const accountValuations = useMemo(
    () => ({
      funding: getAssetAccountValuation(snapshot, 'funding'),
      spot: getAssetAccountValuation(snapshot, 'spot'),
      contract: getAssetAccountValuation(snapshot, 'contract'),
    }),
    [snapshot],
  );
  const distributionItems = useMemo<AssetDistributionItem[]>(
    () =>
      accountMeta.map(item => ({
        key: item.key,
        label: t(item.labelKey),
        value: accountValuations[item.key].totalUsdt,
        color: item.color,
      })),
    [accountValuations, t],
  );
  const spotRows = useMemo(
    () => filterAccountRows(valuationRows, 'spot'),
    [valuationRows],
  );
  const contractRows = useMemo(
    () => filterAccountRows(valuationRows, 'contract'),
    [valuationRows],
  );

  const handleQuickAction = useCallback(
    (action: AssetQuickActionKey) => {
      if (action === 'deposit') navigation.navigate('AssetDeposit');
      if (action === 'withdraw') navigation.navigate('AssetWithdraw');
      if (action === 'transfer') navigation.navigate('AssetTransfer');
      if (action === 'history') navigation.navigate('AssetHistory');
    },
    [navigation],
  );

  return (
    <AppScreen contentWidth="dashboard">
      <AssetTopTabs activeKey={activeTab} onChange={setActiveTab} />
      {activeTab === 'overview' ? (
        <>
          <AssetOverviewCard
            fetchedAt={snapshot?.fetchedAt}
            hidden={hidden}
            isLoggedIn={isLoggedIn}
            loading={
              isLoggedIn && assetSnapshotState.loading && snapshot === null
            }
            snapshotAvailable={Boolean(isLoggedIn && snapshot)}
            stale={assetSnapshotState.stale}
            totalUsdt={isLoggedIn ? snapshot?.totalUsdt ?? null : null}
            valuationComplete={Boolean(
              isLoggedIn && snapshot?.valuationComplete,
            )}
            onToggleHidden={() => setHidden(current => !current)}
          />
          <AssetQuickActions onActionPress={handleQuickAction} />
          {isLoggedIn ? (
            <AssetStockTokenEntry
              onPress={() => navigation.navigate('StockTokenCenter')}
            />
          ) : null}
        </>
      ) : null}
      {!isLoggedIn ? (
        <GuestAssetTabCard activeTab={activeTab} onLoginPress={openLogin} />
      ) : assetSnapshotState.error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>
            {assetSnapshotState.stale && snapshot
              ? t('assets.staleError', { message: assetSnapshotState.error })
              : assetSnapshotState.error}
          </Text>
          <Pressable
            accessibilityLabel={t('assets.reloadA11y')}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
            onPress={assetSnapshotState.reload}
            style={({ pressed }) => [
              styles.retryButton,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.retryText}>{t('common.reload')}</Text>
          </Pressable>
        </View>
      ) : snapshot && !snapshot.valuationComplete ? (
        <Text style={styles.error}>
          {snapshot.missingPriceSymbols.length > 0
            ? t('assets.missingPrices', {
                symbols: snapshot.missingPriceSymbols.join('、'),
              })
            : t('assets.partialValuation')}
        </Text>
      ) : null}

      {!isLoggedIn ? null : (
        <>
          {activeTab === 'overview' ? (
            <OverviewContent
              accountValuations={accountValuations}
              distributionItems={distributionItems}
              hidden={hidden}
              valuationComplete={Boolean(snapshot?.valuationComplete)}
              valuationRows={valuationRows}
            />
          ) : null}

          {activeTab === 'spot' ? (
            <>
              <AssetAccountHero
                Icon={Coins}
                accentColor={colors.green}
                eyebrow={t('assets.spotEyebrow')}
                meta={t('assets.spotMeta', {
                  holdings: t('assets.countHoldings', {
                    count: accountValuations.spot.positiveAssetCount,
                  }),
                  records: t('assets.countRecords', {
                    count: accountValuations.spot.rowCount,
                  }),
                })}
                title={t('assets.account.spot')}
                value={formatAccountValuation(accountValuations.spot, hidden)}
                valueLabel={t('assets.accountValuation')}
              />
              <AssetCoinList
                emptyTitle={
                  snapshot ? t('assets.spotEmpty') : t('assets.spotUnavailable')
                }
                hidden={hidden}
                items={spotRows}
                title={t('assets.spotAssets')}
              />
            </>
          ) : null}

          {activeTab === 'contract' ? (
            <ContractContent
              account={contractSummary}
              accountValuation={accountValuations.contract}
              error={contractError}
              hidden={hidden}
              loading={secondaryLoading.contract}
              rows={contractRows}
              snapshotAvailable={Boolean(snapshot)}
              onRetryPress={retryActiveTab}
            />
          ) : null}

          {activeTab === 'invite' ? (
            <>
              <AssetInviteSummary
                error={inviteError}
                isLoggedIn={isLoggedIn}
                loading={secondaryLoading.invite}
                overview={inviteOverview}
                onLoginPress={openLogin}
                onRetryPress={retryActiveTab}
              />
              {inviteOverview ? (
                <AssetInviteCommissionRecords
                  items={inviteOverview.recentRecords}
                />
              ) : null}
              <AssetInvitedFriends
                error={invitedFriendsError}
                items={invitedFriends}
                loading={secondaryLoading.invite}
                onRetryPress={retryActiveTab}
              />
            </>
          ) : null}

          {activeTab === 'bd' ? (
            <>
              <AssetBdSummary
                application={bdApplication}
                applicationError={bdApplicationError}
                applicationLoading={secondaryLoading.bd}
                error={bdError}
                isLoggedIn={isLoggedIn}
                loading={secondaryLoading.bd}
                overview={bdOverview}
                submitError={bdSubmitError}
                submitSuccess={bdSubmitSuccess}
                submitting={bdSubmitting}
                onApply={submitBdApplication}
                onLoginPress={openLogin}
                onRetryApplicationPress={retryActiveTab}
                onRetryPress={retryActiveTab}
              />
              {bdOverview?.isBd ? (
                <AssetBdTeamMembers
                  error={bdTeamMembersError}
                  items={bdTeamMembers}
                  loading={secondaryLoading.bd}
                  totalCount={bdOverview.teamCount}
                  onRetryPress={retryActiveTab}
                />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

export function getGuestAssetTabCopy(
  activeTab: AssetTabKey,
  t: Translator = createTranslator('zh-CN'),
) {
  const keys = guestTabCopyKeys[activeTab];
  return {
    eyebrow: t(keys.eyebrow),
    title: t(keys.title),
    description: t(keys.description),
  };
}

export function GuestAssetTabCard({
  activeTab,
  onLoginPress,
}: {
  activeTab: AssetTabKey;
  onLoginPress: () => void;
}) {
  const { t } = useLanguage();
  const copy = getGuestAssetTabCopy(activeTab, t);
  return (
    <View style={styles.loginCard}>
      <Text style={styles.loginEyebrow}>{copy.eyebrow}</Text>
      <Text style={styles.loginTitle}>{copy.title}</Text>
      <Text style={styles.loginDesc}>{copy.description}</Text>
      <Pressable
        accessibilityLabel={t('assets.loginViewA11y', { label: copy.eyebrow })}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.14)' }}
        style={({ pressed }) => [
          styles.loginButton,
          pressed ? styles.pressed : null,
        ]}
        onPress={onLoginPress}
      >
        <Text style={styles.loginText}>{t('assets.loginView')}</Text>
      </Pressable>
    </View>
  );
}

export function OverviewContent({
  accountValuations,
  distributionItems,
  hidden,
  valuationComplete,
  valuationRows,
}: {
  accountValuations: Record<AccountKey, AssetAccountValuation>;
  distributionItems: AssetDistributionItem[];
  hidden: boolean;
  valuationComplete: boolean;
  valuationRows: AssetValuationRow[];
}) {
  const { t } = useLanguage();
  const displayedRows = valuationRows.filter(
    row => (row.available ?? 0) + (row.frozen ?? 0) > 0,
  );
  return (
    <>
      <AssetAccountDistribution
        hidden={hidden}
        items={distributionItems}
        valuationComplete={valuationComplete}
      />
      <View style={styles.summaryCard}>
        <Text style={styles.sectionTitle}>{t('assets.summary')}</Text>
        <AccountSummaryRow
          hidden={hidden}
          label={t('assets.account.funding')}
          valuation={accountValuations.funding}
        />
        <AccountSummaryRow
          hidden={hidden}
          label={t('assets.account.spot')}
          valuation={accountValuations.spot}
        />
        <AccountSummaryRow
          hidden={hidden}
          label={t('assets.account.contract')}
          valuation={accountValuations.contract}
        />
      </View>
      {displayedRows.length > 0 ? (
        <AssetCoinList
          emptyTitle={t('assets.spotEmpty')}
          hidden={hidden}
          items={displayedRows}
        />
      ) : null}
    </>
  );
}

export function ContractContent({
  account,
  accountValuation,
  rows,
  hidden,
  loading,
  error,
  snapshotAvailable,
  onRetryPress,
}: {
  account: ContractAccountSummary | null;
  accountValuation: AssetAccountValuation;
  rows: AssetValuationRow[];
  hidden: boolean;
  loading: boolean;
  error?: string | null;
  snapshotAvailable: boolean;
  onRetryPress: () => void;
}) {
  const { t } = useLanguage();
  if (error) {
    return (
      <AssetEmptyState
        actionLabel={t('common.reload')}
        title={t('assets.contract.unavailable')}
        description={error}
        onActionPress={onRetryPress}
      />
    );
  }

  if (loading && !account && rows.length === 0) {
    return (
      <AssetEmptyState
        title={t('assets.contract.loading')}
        description={t('assets.contract.loadingDescription')}
      />
    );
  }

  if (!account && rows.length === 0) {
    return (
      <AssetEmptyState
        title={
          snapshotAvailable
            ? t('assets.contract.empty')
            : t('assets.contract.assetsUnavailable')
        }
      />
    );
  }

  return (
    <>
      <AssetAccountHero
        Icon={ChartNoAxesCombined}
        accentColor="#9B7CFF"
        eyebrow={t('assets.contract.eyebrow')}
        meta={t('assets.contract.meta', {
          count: accountValuation.positiveAssetCount,
        })}
        title={t('assets.account.contract')}
        value={
          hidden
            ? '******'
            : account?.equity != null
            ? formatContractMetric(account.equity)
            : formatAccountValuation(accountValuation, false)
        }
        valueLabel={t('assets.contract.equity')}
      />
      <View style={styles.contractMetricsCard}>
        <View style={styles.contractMetricsHeader}>
          <Text style={styles.sectionTitle}>
            {t('assets.contract.marginOverview')}
          </Text>
          <View style={styles.liveChip}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{t('assets.contract.live')}</Text>
          </View>
        </View>
        <View style={styles.contractMetricsGrid}>
          <ContractMetric
            hidden={hidden}
            label={t('assets.contract.availableMargin')}
            value={account?.availableMargin}
          />
          <ContractMetric
            hidden={hidden}
            label={t('assets.contract.usedMargin')}
            value={account?.usedMargin}
          />
        </View>
      </View>
      <AssetCoinList
        emptyTitle={
          snapshotAvailable
            ? t('assets.contract.empty')
            : t('assets.contract.assetsUnavailable')
        }
        hidden={hidden}
        items={rows}
        title={t('assets.contract.marginAssets')}
      />
    </>
  );
}

function AccountSummaryRow({
  label,
  valuation,
  hidden,
}: {
  label: string;
  valuation: AssetAccountValuation;
  hidden: boolean;
}) {
  const { t } = useLanguage();
  const value = valuation.totalUsdt;
  const coinCount = valuation.positiveAssetCount;
  return (
    <View style={styles.metricRow}>
      <View>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricMeta}>
          {t('assets.countAssets', { count: coinCount })}
        </Text>
      </View>
      <Text style={styles.metricValue}>
        {hidden
          ? '******'
          : value === null
          ? '-- USDT'
          : `${formatAssetNumber(value, 2)} USDT`}
      </Text>
    </View>
  );
}

function ContractMetric({
  label,
  value,
  hidden,
}: {
  label: string;
  value: number | null | undefined;
  hidden: boolean;
}) {
  return (
    <View style={styles.contractMetric}>
      <Text style={styles.contractMetricLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.contractMetricValue}>
        {hidden ? '******' : formatContractMetric(value)}
      </Text>
    </View>
  );
}

function filterAccountRows(items: AssetValuationRow[], accountKey: AccountKey) {
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

function formatAccountValuation(
  valuation: AssetAccountValuation,
  hidden: boolean,
) {
  if (hidden) return '******';
  return valuation.totalUsdt === null
    ? '-- USDT'
    : `${formatAssetNumber(valuation.totalUsdt, 2)} USDT`;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && /[一-鿿]/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  loginCard: {
    marginTop: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.34)',
    backgroundColor: 'rgba(214,168,50,0.08)',
    padding: 16,
  },
  loginEyebrow: {
    ...typography.bold,
    alignSelf: 'flex-start',
    borderRadius: 99,
    backgroundColor: 'rgba(214,168,50,0.14)',
    color: colors.gold,
    fontSize: 11,
    lineHeight: 22,
    paddingHorizontal: 10,
  },
  loginTitle: {
    ...typography.bold,
    marginTop: 13,
    color: colors.text,
    fontSize: 16,
  },
  loginDesc: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  loginButton: {
    height: 46,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.gold,
    marginTop: 16,
  },
  loginText: {
    ...typography.bold,
    color: colors.black,
    fontSize: 14,
  },
  errorCard: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  error: {
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.24)',
    backgroundColor: 'rgba(214, 168, 50, 0.12)',
    color: colors.gold,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  errorText: {
    color: colors.gold,
    fontSize: 12,
    lineHeight: 17,
  },
  retryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginTop: 6,
    paddingHorizontal: 4,
  },
  retryText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  summaryCard: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 12,
  },
  contractMetricsCard: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  contractMetricsHeader: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  liveChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 99,
    backgroundColor: 'rgba(25,195,125,0.10)',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  liveDot: {
    width: 5,
    height: 5,
    marginRight: 5,
    borderRadius: 3,
    backgroundColor: colors.green,
  },
  liveText: {
    color: colors.green,
    fontSize: 9,
  },
  contractMetricsGrid: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  contractMetric: {
    width: '48%',
    minHeight: 70,
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 11,
  },
  contractMetricLabel: {
    color: colors.textSubtle,
    fontSize: 10,
  },
  contractMetricValue: {
    ...typography.number,
    marginTop: 7,
    color: colors.text,
    fontSize: 12,
    fontWeight: '900',
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
});
