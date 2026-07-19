'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import AssetList from '@/components/asset/AssetList';
import AssetPagination from '@/components/asset/AssetPagination';
import AssetSidebar from '@/components/asset/AssetSidebar';
import AssetTransferModal from '@/components/asset/AssetTransferModal';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { useAuth } from '@/lib/authContext';
import { privateQueryKey } from '@/lib/authPrivateQueries';

import AssetsAPI, {
  type AccountBalanceItem,
  type CoinItem,
} from '@/lib/api/modules/assets';
import TransferAPI, { type TransferRecordItem } from '@/lib/api/modules/transfer';
import {
  getContractAccountSummary,
  type ContractAccountSummary,
} from '@/lib/api/modules/contract';
import { getSpotMarketTickers } from '@/lib/api/modules/spot';
import { buildAssetValuationDistribution } from '@/lib/asset/assetDistribution';

import type { Language } from '@/utils/language';

type AccountKey = 'funding' | 'spot' | 'contract';

type Asset = {
  id: string;
  symbol: string;
  name: string;
  type: 'spot' | 'futures';
  available: number;
  frozen: number;
  total: number;
  price?: number;
  displayPrecision: number;
  hasBalance: boolean;
};

type TransferModalState = {
  open: boolean;
  from: AccountKey;
  to: AccountKey;
  coin: string;
};

type AccountDetailModalState = {
  open: boolean;
  account: AccountKey | null;
};

type AccountDetailRow = {
  symbol: string;
  available: number;
  frozen: number;
  total: number;
  precision: number;
};

type AccountDetailMetric = {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'muted';
};

const TRANSFER_RECORD_PAGE_SIZE = 10;
const ACCOUNT_DETAIL_PAGE_SIZE = 10;
const MAIN_ASSET_ORDER = ['USDT', 'BTC', 'ETH', 'RCB', 'MFC'];

const zeroContractAccount: ContractAccountSummary = {
  user_id: 0,
  margin_asset: 'USDT',
  available_margin: '0',
  used_margin: '0',
  frozen_margin: '0',
  position_margin: '0',
  realized_pnl: '0',
  unrealized_pnl: '0',
  equity: '0',
};

function safeNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function getDisplayPrecision(symbol: string, coin?: CoinItem): number {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const coinPrecision = Number(coin?.display_precision);

  if (normalizedSymbol === 'USDT') return 2;
  if (normalizedSymbol === 'BTC' || normalizedSymbol === 'ETH') {
    if (Number.isFinite(coinPrecision) && coinPrecision > 0) {
      return Math.min(Math.max(coinPrecision, 4), 6);
    }
    return 6;
  }
  if (Number.isFinite(coinPrecision) && coinPrecision > 0) return coinPrecision;
  return 4;
}

function formatNumber(value: string | number | null | undefined, precision = 2): string {
  const num = safeNum(value);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function formatTransferAmount(value: string | number | null | undefined, symbol?: string): string {
  const num = safeNum(value);
  if (Math.abs(num) < 0.00000001) return '0';

  if (String(symbol || '').toUpperCase() === 'USDT') {
    if (Math.abs(num) < 1) {
      return num.toLocaleString('en-US', {
        maximumFractionDigits: 4,
      });
    }
    return num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  return num.toLocaleString('en-US', {
    maximumFractionDigits: 8,
  });
}

function formatAssetQuantity(value: string | number | null | undefined, precision = 4): string {
  const num = safeNum(value);
  const safePrecision = Math.max(0, Number.isFinite(Number(precision)) ? Number(precision) : 4);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: safePrecision,
    maximumFractionDigits: safePrecision,
  });
}

function formatDistributionPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  if (value > 0 && value < 0.01) return '< 0.01%';
  return `${formatNumber(value, 2)}%`;
}

function formatUsdtAmount(value: string | number | null | undefined): string {
  const num = safeNum(value);
  if (num > 0 && num < 0.01) return '< 0.01';
  if (num > 0 && num < 1) {
    return num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildAssets(accountBalances: AccountBalanceItem[], coins: CoinItem[]): Asset[] {
  const coinMap = new Map<string, CoinItem>();
  for (const coin of coins) {
    if (coin?.symbol) coinMap.set(coin.symbol.toUpperCase(), coin);
  }

  const aggregated = new Map<string, { available: number; frozen: number; total: number }>();
  for (const item of accountBalances) {
    const symbol = String(item.symbol || '').trim().toUpperCase();
    if (!symbol) continue;

    const available = safeNum(item.available);
    const frozen = safeNum(item.frozen);
    const current = aggregated.get(symbol) || { available: 0, frozen: 0, total: 0 };

    current.available += available;
    current.frozen += frozen;
    current.total += available + frozen;
    aggregated.set(symbol, current);
  }

  const allSymbols = new Set<string>();
  for (const symbol of coinMap.keys()) allSymbols.add(symbol);
  for (const symbol of aggregated.keys()) allSymbols.add(symbol);

  const assets: Asset[] = [];
  let id = 1;
  for (const symbol of allSymbols) {
    const coin = coinMap.get(symbol);
    const balance = aggregated.get(symbol) || { available: 0, frozen: 0, total: 0 };

    assets.push({
      id: String(id++),
      symbol,
      name: coin?.name || symbol,
      type: 'spot',
      available: balance.available,
      frozen: balance.frozen,
      total: balance.total,
      displayPrecision: getDisplayPrecision(symbol, coin),
      hasBalance: balance.total > 0,
    });
  }

  assets.sort((a, b) => {
    if (a.symbol === 'USDT') return -1;
    if (b.symbol === 'USDT') return 1;
    return a.symbol.localeCompare(b.symbol);
  });

  return assets;
}

function hasVisibleAssetBalance(item: Pick<Asset, 'available' | 'frozen' | 'total'>) {
  const available = safeNum(item.available);
  const frozen = safeNum(item.frozen);
  const total = safeNum(item.total ?? available + frozen);

  return available > 0 || frozen > 0 || total > 0;
}

function getBalance(
  accountBalances: AccountBalanceItem[],
  accountKey: AccountKey,
  symbol = 'USDT',
) {
  return accountBalances
    .filter(
      (item) =>
        String(item.account_key || '').toLowerCase() === accountKey &&
        String(item.symbol || '').toUpperCase() === symbol,
    )
    .reduce(
      (sum, item) => ({
        available: sum.available + safeNum(item.available),
        frozen: sum.frozen + safeNum(item.frozen),
      }),
      { available: 0, frozen: 0 },
    );
}

function buildAccountDetailRows(
  accountBalances: AccountBalanceItem[],
  accountKey: AccountKey,
  coins: CoinItem[],
): AccountDetailRow[] {
  const coinMap = new Map<string, CoinItem>();
  for (const coin of coins) {
    if (coin?.symbol) coinMap.set(coin.symbol.toUpperCase(), coin);
  }

  const rows = new Map<string, { available: number; frozen: number }>();
  for (const item of accountBalances) {
    const itemAccount = String(item.account_key || '').toLowerCase();
    if (itemAccount !== accountKey) continue;

    const symbol = String(item.symbol || item.coin_symbol || '').trim().toUpperCase();
    if (!symbol) continue;

    const current = rows.get(symbol) || { available: 0, frozen: 0 };
    current.available += safeNum(item.available ?? item.available_amount);
    current.frozen += safeNum(item.frozen ?? item.frozen_amount);
    rows.set(symbol, current);
  }

  return Array.from(rows.entries())
    .map(([symbol, balance]) => ({
      symbol,
      available: balance.available,
      frozen: balance.frozen,
      total: balance.available + balance.frozen,
      precision: getDisplayPrecision(symbol, coinMap.get(symbol)),
    }))
    .sort((a, b) => {
      const aHasBalance = a.total > 0;
      const bHasBalance = b.total > 0;
      if (aHasBalance !== bHasBalance) return aHasBalance ? -1 : 1;

      const aMainIndex = MAIN_ASSET_ORDER.indexOf(a.symbol);
      const bMainIndex = MAIN_ASSET_ORDER.indexOf(b.symbol);
      const aIsMain = aMainIndex >= 0;
      const bIsMain = bMainIndex >= 0;
      if (aIsMain !== bIsMain) return aIsMain ? -1 : 1;
      if (aIsMain && bIsMain && aMainIndex !== bMainIndex) return aMainIndex - bMainIndex;

      const totalDiff = b.total - a.total;
      if (Math.abs(totalDiff) > 0) return totalDiff;

      return a.symbol.localeCompare(b.symbol);
    });
}

function buildContractDetailRows(contractAccount: ContractAccountSummary): AccountDetailRow[] {
  const positionMargin = safeNum(contractAccount.position_margin || contractAccount.used_margin);
  const frozenMargin = safeNum(contractAccount.frozen_margin);
  const symbol = String(contractAccount.margin_asset || 'USDT').toUpperCase();

  return [
    {
      symbol,
      available: safeNum(contractAccount.available_margin),
      frozen: positionMargin + frozenMargin,
      total: safeNum(contractAccount.equity),
      precision: getDisplayPrecision(symbol),
    },
  ];
}

function countHeldAssets(accountBalances: AccountBalanceItem[], accountKey: AccountKey) {
  const held = new Set<string>();
  for (const item of accountBalances) {
    if (String(item.account_key || '').toLowerCase() !== accountKey) continue;
    if (safeNum(item.available) + safeNum(item.frozen) <= 0) continue;
    held.add(String(item.symbol || '').toUpperCase());
  }
  return held.size;
}

function sumFrozen(accountBalances: AccountBalanceItem[], accountKey: AccountKey) {
  return accountBalances
    .filter((item) => String(item.account_key || '').toLowerCase() === accountKey)
    .reduce((sum, item) => sum + safeNum(item.frozen), 0);
}

function sumAccountTotal(accountBalances: AccountBalanceItem[], accountKey: AccountKey, symbol = 'USDT') {
  return accountBalances
    .filter(
      (item) =>
        String(item.account_key || '').toLowerCase() === accountKey &&
        String(item.symbol || '').toUpperCase() === symbol,
    )
    .reduce((sum, item) => sum + safeNum(item.available) + safeNum(item.frozen), 0);
}

function getTradeHref(symbol: string) {
  const normalized = String(symbol || '').toUpperCase();
  if (normalized === 'USDT') return null;
  const supported = new Set(['BTC', 'ETH', 'MFC', 'RCB']);
  if (!supported.has(normalized)) return null;
  return `/trade/spot?symbol=${normalized}USDT`;
}

function percentOf(value: number, total: number) {
  if (total <= 0) return 0;
  return (value / total) * 100;
}

type AssetTranslator = (key: string, namespace?: 'asset' | 'common') => string;

function getErrorText(err: unknown, t: AssetTranslator) {
  if (!err) return null;
  return t('assetDataLoadFailed', 'asset');
}

function accountLabel(value: string, t: AssetTranslator) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'funding') return t('fundingAccount', 'asset');
  if (normalized === 'spot') return t('spotAccount', 'asset');
  if (normalized === 'contract') return t('contractAccount', 'asset');
  return value || '--';
}

function transferDirection(record: TransferRecordItem, t: AssetTranslator) {
  return `${accountLabel(record.from_account, t)} → ${accountLabel(record.to_account, t)}`;
}

function statusLabel(status: string, t: AssetTranslator) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'COMPLETED') return t('success', 'asset');
  if (normalized === 'FAILED') return t('failed', 'asset');
  if (normalized === 'PENDING' || normalized === 'PROCESSING') return t('pending', 'asset');
  if (normalized === 'CANCELED' || normalized === 'CANCELLED') return t('canceled', 'asset');
  return status || '--';
}

function statusClass(status: string) {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'SUCCESS' || normalized === 'COMPLETED') return 'bg-[#00c087]/10 text-[#00c087]';
  if (normalized === 'FAILED') return 'bg-[#f6465d]/10 text-[#f6465d]';
  if (normalized === 'CANCELED' || normalized === 'CANCELLED') return 'bg-white/10 text-white/50';
  return 'bg-[#f0b90b]/10 text-[#f0b90b]';
}

export default function AssetPage() {
  const router = useRouter();
  const { locale, t } = useLocaleContext();
  const { userIdentityKey } = useAuth();
  const currentLanguage: Language = locale;

  const [searchKeyword, setSearchKeyword] = useState('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [transferRecordsPage, setTransferRecordsPage] = useState(1);
  const [transferModal, setTransferModal] = useState<TransferModalState>({
    open: false,
    from: 'funding',
    to: 'spot',
    coin: 'USDT',
  });
  const [accountDetailModal, setAccountDetailModal] = useState<AccountDetailModalState>({
    open: false,
    account: null,
  });
  const [accountDetailPage, setAccountDetailPage] = useState(1);
  const [isRefreshingAssets, setIsRefreshingAssets] = useState(false);
  const [assetRefreshStatus, setAssetRefreshStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [assetRefreshTime, setAssetRefreshTime] = useState('');

  const accountBalancesQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, 'assetAccountBalances'),
    queryFn: () => AssetsAPI.getAccountBalances(),
    enabled: userIdentityKey !== null,
    staleTime: 1000 * 30,
    retry: 0,
  });

  const coinsQuery = useQuery({
    queryKey: ['assetCoins'],
    queryFn: () => AssetsAPI.getCoins(),
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    retry: 0,
  });

  const contractAccountQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, 'assetContractAccountSummary'),
    queryFn: () => getContractAccountSummary(),
    enabled: userIdentityKey !== null,
    staleTime: 1000 * 15,
    retry: 0,
  });

  const transferRecordsQuery = useQuery({
    queryKey: privateQueryKey(userIdentityKey, 'assetTransferRecords', transferRecordsPage),
    queryFn: () => TransferAPI.getTransferRecords({ page: transferRecordsPage, page_size: TRANSFER_RECORD_PAGE_SIZE }),
    enabled: userIdentityKey !== null,
    staleTime: 1000 * 15,
    retry: 0,
  });

  const accountBalances = useMemo(
    () => accountBalancesQuery.data || [],
    [accountBalancesQuery.data],
  );

  const coins = useMemo(() => coinsQuery.data || [], [coinsQuery.data]);
  const assets = useMemo(() => buildAssets(accountBalances, coins), [accountBalances, coins]);
  const visibleAssets = useMemo(() => assets.filter(hasVisibleAssetBalance), [assets]);
  const distributionSymbols = useMemo(
    () => Array.from(
      new Set(visibleAssets.map((asset) => asset.symbol).filter((symbol) => symbol !== 'USDT')),
    ),
    [visibleAssets],
  );
  const distributionTickersQuery = useQuery({
    queryKey: ['assetDistributionTickers', distributionSymbols],
    queryFn: () => getSpotMarketTickers(distributionSymbols.map((symbol) => `${symbol}USDT`)),
    enabled: distributionSymbols.length > 0,
    staleTime: 1000 * 15,
    retry: 0,
  });
  const contractAccount = contractAccountQuery.data || zeroContractAccount;
  const fundingDetailRows = useMemo(
    () => buildAccountDetailRows(accountBalances, 'funding', coins),
    [accountBalances, coins],
  );
  const spotDetailRows = useMemo(
    () => buildAccountDetailRows(accountBalances, 'spot', coins),
    [accountBalances, coins],
  );
  const contractDetailRows = useMemo(
    () => buildContractDetailRows(contractAccount),
    [contractAccount],
  );
  const contractDetailMetrics = useMemo<AccountDetailMetric[]>(() => {
    const realizedPnl = safeNum(contractAccount.realized_pnl);
    return [
      { label: t('availableMargin', 'asset'), value: `${formatUsdtAmount(contractAccount.available_margin)} USDT` },
      { label: t('positionMargin', 'asset'), value: `${formatUsdtAmount(contractAccount.position_margin || contractAccount.used_margin)} USDT` },
      { label: t('frozenMargin', 'asset'), value: `${formatUsdtAmount(contractAccount.frozen_margin)} USDT` },
      { label: t('accountEquity', 'asset'), value: `${formatUsdtAmount(contractAccount.equity)} USDT` },
      {
        label: t('realizedPnl', 'asset'),
        value: `${formatUsdtAmount(contractAccount.realized_pnl)} USDT`,
        tone: realizedPnl > 0 ? 'positive' : realizedPnl < 0 ? 'negative' : 'muted',
      },
    ];
  }, [contractAccount, t]);

  const accountStats = useMemo(() => {
    const fundingUsdt = getBalance(accountBalances, 'funding');
    const spotUsdt = getBalance(accountBalances, 'spot');
    const contractUsdt = getBalance(accountBalances, 'contract');
    const spotFrozen = sumFrozen(accountBalances, 'spot');
    const fundingUsdtTotal = sumAccountTotal(accountBalances, 'funding');
    const spotUsdtTotal = sumAccountTotal(accountBalances, 'spot');
    const contractUsdtTotal = sumAccountTotal(accountBalances, 'contract');

    return {
      fundingUsdt,
      spotUsdt,
      contractUsdt,
      spotFrozen,
      fundingUsdtTotal,
      spotUsdtTotal,
      contractUsdtTotal,
      fundingHeldCount: countHeldAssets(accountBalances, 'funding'),
      spotHeldCount: countHeldAssets(accountBalances, 'spot'),
      totalAssets: fundingUsdtTotal + spotUsdtTotal + contractUsdtTotal,
      totalAvailable:
        fundingUsdt.available +
        spotUsdt.available +
        contractUsdt.available,
      totalFrozen: fundingUsdt.frozen + spotUsdt.frozen + contractUsdt.frozen,
    };
  }, [accountBalances]);

  const openTransfer = useCallback((from: AccountKey, to: AccountKey, coin = 'USDT') => {
    setTransferModal({
      open: true,
      from,
      to,
      coin,
    });
  }, []);

  const openAccountDetails = useCallback((account: AccountKey) => {
    setAccountDetailPage(1);
    setAccountDetailModal({
      open: true,
      account,
    });
  }, []);

  const accountDistribution = useMemo(() => {
    const items = [
      {
        key: 'funding',
        title: t('fundingAccount', 'asset'),
        value: accountStats.fundingUsdtTotal,
        description: t('fundingAccountDesc', 'asset'),
        actions: (
          <>
            <Link href="/asset/deposit?coin=USDT" className="rounded-lg bg-[#f0b90b] px-3 py-2 text-center text-xs font-semibold text-black hover:bg-[#f8d12f]">
              {t('recharge', 'asset')}
            </Link>
            <Link href="/asset/withdraw?coin=USDT" className="rounded-lg border border-white/10 px-3 py-2 text-center text-xs font-semibold text-white/80 hover:bg-white/[0.06]">
              {t('withdraw', 'asset')}
            </Link>
          </>
        ),
      },
      {
        key: 'spot',
        title: t('spotAccount', 'asset'),
        value: accountStats.spotUsdtTotal,
        description: t('spotAccountDesc', 'asset'),
        actions: (
          <>
            <Link href="/trade/spot" className="rounded-lg bg-white px-3 py-2 text-center text-xs font-semibold text-black hover:bg-white/85">
              {t('goSpotTrade', 'asset')}
            </Link>
          </>
        ),
      },
      {
        key: 'contract',
        title: t('contractAccount', 'asset'),
        value: accountStats.contractUsdtTotal,
        description: t('contractAccountDesc', 'asset'),
        actions: (
          <>
            <Link href="/contract" className="rounded-lg bg-white px-3 py-2 text-center text-xs font-semibold text-black hover:bg-white/85">
              {t('goContractTrade', 'asset')}
            </Link>
          </>
        ),
      },
    ];

    return items.map((item) => ({
      ...item,
      percent: percentOf(item.value, accountStats.totalAssets),
    }));
  }, [accountStats, t]);

  const assetDistribution = useMemo(() => {
    return buildAssetValuationDistribution(
      visibleAssets,
      distributionTickersQuery.data || [],
    ).map((item, index) => ({
      ...item,
      color: ['#26a17b', '#f7931a', '#627eea', '#f0b90b', '#00c087', '#8b5cf6'][index % 6],
    }));
  }, [distributionTickersQuery.data, visibleAssets]);

  const filteredAssets = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return visibleAssets;

    return visibleAssets.filter((asset) => {
      return (
        asset.symbol.toLowerCase().includes(keyword) ||
        asset.name.toLowerCase().includes(keyword)
      );
    });
  }, [visibleAssets, searchKeyword]);

  const error = useMemo(() => {
    return getErrorText(accountBalancesQuery.error || coinsQuery.error, t);
  }, [accountBalancesQuery.error, coinsQuery.error, t]);

  const isLoading = accountBalancesQuery.isLoading || coinsQuery.isLoading;
  const transferRecords = transferRecordsQuery.data?.items || [];
  const selectedAccountRows =
    accountDetailModal.account === 'funding'
      ? fundingDetailRows
      : accountDetailModal.account === 'spot'
        ? spotDetailRows
        : contractDetailRows;
  const accountDetailTotalPages = Math.max(
    1,
    Math.ceil(selectedAccountRows.length / ACCOUNT_DETAIL_PAGE_SIZE),
  );
  const safeAccountDetailPage = Math.min(accountDetailPage, accountDetailTotalPages);

  const closeTransfer = () => {
    setTransferModal((state) => ({ ...state, open: false }));
  };

  const closeAccountDetails = () => {
    setAccountDetailModal({ open: false, account: null });
  };

  const refreshAssetData = async () => {
    if (isRefreshingAssets) return;
    setIsRefreshingAssets(true);
    setAssetRefreshStatus('idle');
    const startedAt = Date.now();
    try {
      await Promise.all([
        accountBalancesQuery.refetch(),
        coinsQuery.refetch(),
        contractAccountQuery.refetch(),
        transferRecordsQuery.refetch(),
      ]);
      const elapsed = Date.now() - startedAt;
      if (elapsed < 600) {
        await new Promise((resolve) => setTimeout(resolve, 600 - elapsed));
      }
      setAssetRefreshTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
      setAssetRefreshStatus('success');
    } catch {
      setAssetRefreshStatus('error');
    } finally {
      setIsRefreshingAssets(false);
    }
  };

  const handleRetry = async () => {
    await Promise.all([accountBalancesQuery.refetch(), coinsQuery.refetch()]);
  };

  const handleRecharge = (symbol: string) => {
    router.push(`/asset/deposit?coin=${encodeURIComponent(symbol)}`);
  };

  const handleWithdraw = (symbol: string) => {
    router.push(`/asset/withdraw?coin=${encodeURIComponent(symbol)}`);
  };

  const handleTrade = (symbol: string) => {
    const href = getTradeHref(symbol);
    if (href) router.push(href);
  };

  return (
    <main className="flex min-h-screen flex-col overflow-y-auto bg-[#090d12] py-8 lg:flex-row">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="min-w-0 flex-1 px-4">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">{t('assetOverview', 'asset')}</h1>
            <p className="mt-2 text-sm text-white/55">
              {t('assetOverviewDesc', 'asset')}
            </p>
            {isRefreshingAssets ? (
              <p className="mt-2 text-xs text-[#f0b90b]">{t('assetRefreshing', 'asset')}</p>
            ) : assetRefreshStatus === 'success' ? (
              <p className="mt-2 text-xs text-emerald-300">
                {t('assetRefreshSuccess', 'asset')} {assetRefreshTime}
              </p>
            ) : assetRefreshStatus === 'error' ? (
              <p className="mt-2 text-xs text-red-300">{t('assetRefreshFailed', 'asset')}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void refreshAssetData()}
            disabled={isRefreshingAssets}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-white/70 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={t('refreshAssetData', 'asset')}
            title={t('refreshAssetData', 'asset')}
          >
            <svg
              className={`h-4 w-4 ${isRefreshingAssets ? 'animate-spin' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M20 4v5h-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {error ? (
          <div className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-red-400">{error}</span>
              <button
                className="text-white bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm"
                onClick={handleRetry}
              >
                {t('retry', 'asset')}
              </button>
            </div>
          </div>
        ) : null}

        <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <SummaryCard
            label={t('totalAssetEstimate', 'asset')}
            value={`${formatNumber(accountStats.totalAssets)} USDT`}
            hint={t('totalAssetEstimateHint', 'asset')}
            loading={isLoading}
          />
          <SummaryCard
            label={t('availableAsset', 'asset')}
            value={`${formatNumber(accountStats.totalAvailable)} USDT`}
            hint={t('availableAssetHint', 'asset')}
            loading={isLoading}
          />
          <SummaryCard
            label={t('frozenOccupied', 'asset')}
            value={`${formatNumber(accountStats.totalFrozen)} USDT`}
            hint={t('frozenOccupiedHint', 'asset')}
            loading={isLoading}
          />
        </section>

        <section className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <AccountDistributionSection
            items={accountDistribution}
            loading={isLoading}
            onTransferClick={() => openTransfer('funding', 'spot')}
          />
          <AssetDistributionSection
            items={assetDistribution}
            loading={isLoading || distributionTickersQuery.isLoading}
          />
        </section>

        <section className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
          <AccountCard
            title={t('fundingAccount', 'asset')}
            description={t('fundingAccountDesc', 'asset')}
            onOpenDetails={() => openAccountDetails('funding')}
            metrics={[
              { label: t('usdtAvailable', 'asset'), value: `${formatUsdtAmount(accountStats.fundingUsdt.available)} USDT` },
              { label: t('usdtFrozen', 'asset'), value: `${formatUsdtAmount(accountStats.fundingUsdt.frozen)} USDT` },
              { label: t('accountDetails', 'asset'), value: t('clickToView', 'asset') },
            ]}
            actions={
              <>
                <Link
                  href="/asset/deposit?coin=USDT"
                  className="rounded-lg bg-[#f0b90b] px-3 py-2 text-center text-xs font-semibold text-black hover:bg-[#f8d12f]"
                >
                  {t('recharge', 'asset')}
                </Link>
                <Link
                  href="/asset/withdraw?coin=USDT"
                  className="rounded-lg border border-white/10 px-3 py-2 text-center text-xs font-semibold text-white/80 hover:bg-white/[0.06]"
                >
                  {t('withdraw', 'asset')}
                </Link>
              </>
            }
          />

          <AccountCard
            title={t('spotAccount', 'asset')}
            description={t('spotAccountDesc', 'asset')}
            onOpenDetails={() => openAccountDetails('spot')}
            metrics={[
              { label: t('usdtAvailable', 'asset'), value: `${formatUsdtAmount(accountStats.spotUsdt.available)} USDT` },
              { label: t('frozenAssets', 'asset'), value: `${formatUsdtAmount(accountStats.spotFrozen)} USDT` },
              { label: t('accountDetails', 'asset'), value: t('clickToView', 'asset') },
            ]}
            actions={
              <>
                <Link
                  href="/trade/spot"
                  className="rounded-lg bg-white px-3 py-2 text-center text-xs font-semibold text-black hover:bg-white/85"
                >
                  {t('goSpotTrade', 'asset')}
                </Link>
              </>
            }
          />

          <AccountCard
            title={t('contractAccount', 'asset')}
            description={t('contractAccountDesc', 'asset')}
            onOpenDetails={() => openAccountDetails('contract')}
            footer={contractAccountQuery.isError ? t('noContractAssets', 'asset') : undefined}
            metrics={[
              { label: t('availableMargin', 'asset'), value: `${formatUsdtAmount(contractAccount.available_margin)} USDT` },
              { label: t('positionMargin', 'asset'), value: `${formatUsdtAmount(contractAccount.position_margin || contractAccount.used_margin)} USDT` },
              { label: t('frozenMargin', 'asset'), value: `${formatUsdtAmount(contractAccount.frozen_margin)} USDT` },
              { label: t('accountEquity', 'asset'), value: `${formatUsdtAmount(contractAccount.equity)} USDT` },
              {
                label: t('realizedPnl', 'asset'),
                value: `${formatUsdtAmount(contractAccount.realized_pnl)} USDT`,
                tone:
                  safeNum(contractAccount.realized_pnl) > 0
                    ? 'positive'
                    : safeNum(contractAccount.realized_pnl) < 0
                      ? 'negative'
                      : 'muted',
              },
            ]}
            actions={
              <>
                <Link
                  href="/contract"
                  className="rounded-lg bg-white px-3 py-2 text-center text-xs font-semibold text-black hover:bg-white/85"
                >
                  {t('goContractTrade', 'asset')}
                </Link>
              </>
            }
          />
        </section>

        <AssetList
          assets={filteredAssets}
          isLoading={isLoading}
          onRecharge={handleRecharge}
          onWithdraw={handleWithdraw}
          onTrade={handleTrade}
          onSearch={setSearchKeyword}
          searchKeyword={searchKeyword}
          currentLanguage={currentLanguage}
        />

        <TransferRecordsSection
          records={transferRecords}
          loading={transferRecordsQuery.isLoading}
          error={getErrorText(transferRecordsQuery.error, t)}
          page={transferRecordsQuery.data?.page || transferRecordsPage}
          pageSize={transferRecordsQuery.data?.page_size || TRANSFER_RECORD_PAGE_SIZE}
          total={transferRecordsQuery.data?.total || 0}
          onPageChange={setTransferRecordsPage}
        />
      </div>

      <AssetTransferModal
        open={transferModal.open}
        onClose={closeTransfer}
        defaultFrom={transferModal.from}
        defaultTo={transferModal.to}
        defaultCoin={transferModal.coin}
        onSuccess={refreshAssetData}
      />
      <AccountDetailModal
        open={accountDetailModal.open}
        account={accountDetailModal.account}
        rows={selectedAccountRows}
        loading={accountDetailModal.account === 'contract' ? contractAccountQuery.isLoading : isLoading}
        page={safeAccountDetailPage}
        pageSize={ACCOUNT_DETAIL_PAGE_SIZE}
        contractMetrics={accountDetailModal.account === 'contract' ? contractDetailMetrics : []}
        onPageChange={setAccountDetailPage}
        onClose={closeAccountDetails}
      />
    </main>
  );
}

function AccountDistributionSection({
  items,
  loading,
  onTransferClick,
}: {
  items: Array<{
    key: string;
    title: string;
    value: number;
    percent: number;
    description: string;
    actions: React.ReactNode;
  }>;
  loading?: boolean;
  onTransferClick: () => void;
}) {
  const { t } = useLocaleContext();

  return (
    <section className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('accountDistribution', 'asset')}</h2>
          <p className="mt-1 text-sm text-white/45">{t('accountDistributionDesc', 'asset')}</p>
        </div>
        <button
          type="button"
          onClick={onTransferClick}
          className="shrink-0 rounded-lg bg-[#f0b90b] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#f8d12f]"
        >
          {t('transferFunds', 'asset')}
        </button>
      </div>
      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.key} className="rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="text-sm font-semibold text-white">{item.title}</div>
                <div className="mt-1 text-xs text-white/45">{item.description}</div>
              </div>
              <div className="text-left md:text-right">
                <div className="text-base font-semibold tabular-nums text-white">
                  {loading ? '...' : `${formatNumber(item.value)} USDT`}
                </div>
                <div className="mt-1 text-xs text-white/45">{formatNumber(item.percent, 2)}%</div>
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[#f0b90b]"
                style={{ width: `${Math.min(Math.max(item.percent, 0), 100)}%` }}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">{item.actions}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AssetDistributionSection({
  items,
  loading,
}: {
  items: Array<{
    symbol: string;
    amount: number;
    precision: number;
    usdtValue: number | null;
    percent: number | null;
    color: string;
  }>;
  loading?: boolean;
}) {
  const { t } = useLocaleContext();

  return (
    <section className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-white">{t('assetDistribution', 'asset')}</h2>
        <p className="mt-1 text-sm text-white/45">{t('assetDistributionDesc', 'asset')}</p>
      </div>

      {loading ? (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-white/10" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-8 text-center text-sm text-white/45">
          {t('noAssetDistribution', 'asset')}
        </div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {items.map((item) => (
            <div key={item.symbol} className="rounded-lg bg-black/10 px-2 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="shrink-0 font-semibold text-white">{item.symbol}</span>
                  <span className="shrink-0 text-xs tabular-nums text-white/45">
                    {formatAssetQuantity(item.amount, item.precision)}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs font-medium tabular-nums text-white/75">
                    {item.usdtValue === null ? '--' : `≈ ${formatUsdtAmount(item.usdtValue)} USDT`}
                  </div>
                  <div className="text-[11px] text-white/45">{formatDistributionPercent(item.percent)}</div>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: item.percent && item.percent > 0
                      ? `${Math.min(Math.max(item.percent, 0.4), 100)}%`
                      : '0%',
                    backgroundColor: item.color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function SummaryCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="text-sm text-white/50">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-white">
        {loading ? '...' : value}
      </div>
      <div className="mt-2 text-xs text-white/45">{hint}</div>
    </div>
  );
}

function AccountCard({
  title,
  description,
  metrics,
  actions,
  footer,
  onOpenDetails,
}: {
  title: string;
  description: string;
  metrics: Array<{ label: string; value: string; tone?: 'positive' | 'negative' | 'muted' }>;
  actions: React.ReactNode;
  footer?: string;
  onOpenDetails: () => void;
}) {
  const { t } = useLocaleContext();
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="mt-1 text-sm leading-5 text-white/50">{description}</p>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetails();
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-lg text-white/55 transition hover:border-[#f0b90b]/45 hover:text-[#f0b90b]"
          aria-label={`${t('viewAccountDetails', 'asset')}: ${title}`}
        >
          →
        </button>
      </div>
      <div className="mt-5 space-y-3">
        {metrics.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-white/45">{item.label}</span>
            <span
              className={[
                'tabular-nums',
                item.tone === 'positive'
                  ? 'text-[#00c087]'
                  : item.tone === 'negative'
                    ? 'text-[#f6465d]'
                    : 'text-white',
              ].join(' ')}
            >
              {item.value}
            </span>
          </div>
        ))}
      </div>
      {footer ? <div className="mt-3 text-xs text-white/35">{footer}</div> : null}
    </>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenDetails();
        }
      }}
      className="flex min-h-[260px] cursor-pointer flex-col justify-between rounded-xl border border-white/10 bg-[#0e1117] p-5 text-left shadow-xl transition-colors hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-[#f0b90b]/45"
    >
      <div>{content}</div>
      <div
        className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
      </div>
    </div>
  );
}

function AccountDetailModal({
  open,
  account,
  rows,
  loading,
  page,
  pageSize,
  contractMetrics,
  onPageChange,
  onClose,
}: {
  open: boolean;
  account: AccountKey | null;
  rows: AccountDetailRow[];
  loading?: boolean;
  page: number;
  pageSize: number;
  contractMetrics?: AccountDetailMetric[];
  onPageChange: (page: number) => void;
  onClose: () => void;
}) {
  const { t } = useLocaleContext();

  if (!open || !account) return null;

  const shouldPaginate = account !== 'contract';
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const visibleRows = shouldPaginate
    ? rows.slice((safePage - 1) * pageSize, safePage * pageSize)
    : rows;

  const titleMap: Record<AccountKey, string> = {
    funding: t('fundingAccountDetails', 'asset'),
    spot: t('spotAccountDetails', 'asset'),
    contract: t('contractAccountDetails', 'asset'),
  };
  const frozenTitle = account === 'contract' ? t('frozenOrUsedMargin', 'asset') : t('frozenBalance', 'asset');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0e1117] shadow-2xl shadow-black/50"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{titleMap[account]}</h2>
            <p className="mt-1 text-xs text-white/45">
              {account === 'contract' ? t('contractAccountSummaryDesc', 'asset') : t('accountBalanceSummaryDesc', 'asset')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-xl text-white/60 transition hover:bg-white/[0.08] hover:text-white"
            aria-label={t('closeAccountDetails', 'asset')}
          >
            ×
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-12 animate-pulse rounded-xl bg-white/10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/15 px-4 py-10 text-center text-sm text-white/45">
              {t('noAssets', 'asset')}
            </div>
          ) : (
            <>
            <div className="max-h-[46vh] overflow-auto rounded-xl border border-white/10 bg-black/10">
              <table className="w-full min-w-[680px]">
                <thead className="sticky top-0 z-10 bg-[#10151d]">
                  <tr className="border-b border-white/10 text-xs text-white/45">
                    <th className="py-3 text-left font-medium">{t('coin', 'asset')}</th>
                    <th className="py-3 text-right font-medium">{t('availableBalance', 'asset')}</th>
                    <th className="py-3 text-right font-medium">{frozenTitle}</th>
                    <th className="py-3 text-right font-medium">{t('total', 'asset')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.symbol} className="border-b border-white/5 text-sm last:border-0">
                      <td className="py-3 pr-4 font-semibold text-white">{row.symbol}</td>
                      <td className="py-3 text-right tabular-nums text-white/80">
                        {formatNumber(row.available, row.precision)}
                      </td>
                      <td className="py-3 text-right tabular-nums text-white/80">
                        {formatNumber(row.frozen, row.precision)}
                      </td>
                      <td className="py-3 text-right tabular-nums text-white">
                        {formatNumber(row.total, row.precision)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shouldPaginate ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="text-white/45">
                  {t('totalCoinPageInfoPrefix', 'asset')} {rows.length} {t('totalCoinPageInfoMiddle', 'asset')} {safePage} / {totalPages} {t('totalCoinPageInfoSuffix', 'asset')}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => onPageChange(safePage - 1)}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-white/70 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('prevPage', 'asset')}
                  </button>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => onPageChange(safePage + 1)}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-white/70 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('nextPage', 'asset')}
                  </button>
                </div>
              </div>
            ) : null}
            </>
          )}

          {account === 'contract' && contractMetrics && contractMetrics.length > 0 ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {contractMetrics.map((metric) => (
                <div key={metric.label} className="rounded-xl border border-white/10 bg-black/15 p-3">
                  <div className="text-xs text-white/45">{metric.label}</div>
                  <div
                    className={[
                      'mt-2 break-words text-sm font-semibold tabular-nums',
                      metric.tone === 'positive'
                        ? 'text-[#00c087]'
                        : metric.tone === 'negative'
                          ? 'text-[#f6465d]'
                          : 'text-white',
                    ].join(' ')}
                  >
                    {metric.value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TransferRecordsSection({
  records,
  loading,
  error,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  records: TransferRecordItem[];
  loading?: boolean;
  error?: string | null;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useLocaleContext();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);

  return (
    <section className="mt-6 rounded-xl border border-white/10 bg-[#0e1117] p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('transferRecords', 'asset')}</h2>
          <p className="mt-1 text-sm text-white/45">{t('transferRecordsDesc', 'asset')}</p>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-[#f6465d]/25 bg-[#f6465d]/10 px-3 py-2 text-sm text-[#f6465d]">
          {t('transferRecordsLoadFailed', 'asset')}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-white/10 text-sm text-white/45">
              <th className="py-3 text-left font-medium">{t('coin', 'asset')}</th>
              <th className="py-3 text-left font-medium">{t('direction', 'asset')}</th>
              <th className="py-3 pr-8 text-right font-medium">{t('quantity', 'asset')}</th>
              <th className="py-3 pl-8 text-center font-medium">{t('status', 'asset')}</th>
              <th className="py-3 text-right font-medium">{t('time', 'asset')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 3 }).map((_, index) => (
                <tr key={index} className="border-b border-white/5">
                  <td className="py-4">
                    <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
                  </td>
                  <td className="py-4">
                    <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
                  </td>
                  <td className="py-4">
                    <div className="ml-auto h-4 w-24 animate-pulse rounded bg-white/10" />
                  </td>
                  <td className="py-4 pl-8">
                    <div className="mx-auto h-6 w-20 animate-pulse rounded-full bg-white/10" />
                  </td>
                  <td className="py-4">
                    <div className="ml-auto h-4 w-32 animate-pulse rounded bg-white/10" />
                  </td>
                </tr>
              ))
            ) : records.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-sm text-white/45">
                  {t('noTransferRecords', 'asset')}
                </td>
              </tr>
            ) : (
              records.map((record) => (
                <tr key={record.id} className="border-b border-white/5 text-sm last:border-0">
                  <td className="py-3 text-white">{record.symbol || 'USDT'}</td>
                  <td className="py-3 text-white/70">{transferDirection(record, t)}</td>
                  <td className="py-3 pr-8 text-right tabular-nums text-white">
                    {formatTransferAmount(record.amount, record.symbol)}
                  </td>
                  <td className="py-3 pl-8 text-center">
                    <span
                      className={[
                        'inline-flex min-w-20 justify-center rounded-full px-2.5 py-1 text-xs font-medium',
                        statusClass(record.status),
                      ].join(' ')}
                    >
                        {statusLabel(record.status, t)}
                    </span>
                  </td>
                  <td className="py-3 text-right text-white/55">{record.created_at || '--'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading ? (
        <AssetPagination
          page={safePage}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
        />
      ) : null}
    </section>
  );
}
