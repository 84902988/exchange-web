'use client';

import { useEffect, useMemo, useState } from 'react';

import AssetSidebar from '@/components/asset/AssetSidebar';
import { useLocaleContext } from '@/contexts/LocaleContext';
import AssetsAPI, { type BalanceLogItem } from '@/lib/api/modules/assets';

const PAGE_SIZE = 20;

const BIZ_TYPE_OPTIONS = [
  { value: 'ALL', labelKey: 'bizAll', query: '' },
  { value: 'DEPOSIT', labelKey: 'recharge', query: 'DEPOSIT' },
  { value: 'WITHDRAW', labelKey: 'withdraw', query: 'WITHDRAW_SUCCESS' },
  { value: 'USER_TRANSFER', labelKey: 'userTransfer', query: 'USER_TRANSFER' },
  { value: 'TRANSFER', labelKey: 'transfer', query: 'TRANSFER' },
  { value: 'TRADE', labelKey: 'tradeFundsChange', query: 'TRADE' },
  { value: 'FEE', labelKey: 'tradeFee', query: 'TRADE_FEE' },
  { value: 'BD_COMMISSION', labelKey: 'bdCommission', query: 'BD_COMMISSION_CREDIT' },
  { value: 'USER_INVITE_COMMISSION', labelKey: 'inviteReward', query: 'USER_INVITE_COMMISSION_CREDIT' },
  { value: 'DIVIDEND', labelKey: 'dividend', query: 'DIVIDEND' },
  { value: 'STOCK_TOKEN_CONVERT', labelKey: 'stockTokenConvert', query: 'STOCK_TOKEN_CONVERT' },
  { value: 'FREEZE', labelKey: 'freeze', query: 'FREEZE' },
  { value: 'UNFREEZE', labelKey: 'unfreeze', query: 'UNFREEZE' },
  { value: 'ADJUST', labelKey: 'platformAdjust', query: 'ADJUST' },
];

const COIN_OPTIONS = ['', 'USDT', 'RCB', 'BTC', 'ETH', 'MFC'];

const ACCOUNT_OPTIONS = [
  { value: '', labelKey: 'allAccounts' },
  { value: 'funding', labelKey: 'fundingAccount' },
  { value: 'spot', labelKey: 'spotAccount' },
  { value: 'contract', labelKey: 'contractAccount' },
];

function queryBizType(value: string) {
  return BIZ_TYPE_OPTIONS.find((option) => option.value === value)?.query || '';
}

type AssetTranslator = (key: string, namespace?: 'asset' | 'common') => string;

function accountLabel(value: string | null | undefined, t: AssetTranslator) {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'funding') return t('fundingAccount', 'asset');
  if (normalized === 'spot') return t('spotAccount', 'asset');
  if (normalized === 'contract') return t('contractAccount', 'asset');
  if (normalized === 'bsc') return 'BSC';
  if (normalized === 'polygon') return 'Polygon';
  if (normalized === 'avaxc') return 'Avalanche C-Chain';
  if (normalized === 'ethereum') return 'Ethereum';
  if (normalized === 'optimism') return 'Optimism';
  if (normalized === 'tron') return 'TRON';
  if (normalized === 'solana') return 'Solana';
  return value || '--';
}

const BALANCE_LOG_TYPE_LABEL_KEYS: Record<string, string> = {
  DEPOSIT: 'chainDepositArrived',
  DEPOSIT_CREDIT: 'chainDepositArrived',
  WITHDRAW: 'withdraw',
  WITHDRAW_DEBIT: 'withdrawDebit',
  WITHDRAW_SUCCESS: 'withdrawSuccess',
  WITHDRAW_REFUND: 'withdrawRefund',
  WITHDRAW_UNFREEZE: 'withdrawUnfreeze',
  USER_TRANSFER: 'internalTransfer',
  USER_TRANSFER_IN: 'internalTransferIn',
  USER_TRANSFER_OUT: 'internalTransferOut',
  TRANSFER: 'accountTransfer',
  TRANSFER_IN: 'accountTransferIn',
  TRANSFER_OUT: 'accountTransferOut',
  TRADE: 'tradeFundsChange',
  TRADE_FEE: 'tradeFee',
  TRADE_FEE_DEBIT: 'tradeFee',
  TRADE_FEE_CREDIT: 'tradeFeeCredit',
  DIVIDEND: 'dividendPayout',
  DIVIDEND_CREDIT: 'dividendPayout',
  DIVIDEND_PAYOUT: 'dividendPayout',
  BD_COMMISSION: 'bdCommissionPayout',
  BD_COMMISSION_CREDIT: 'bdCommissionPayout',
  BD_COMMISSION_DEBIT: 'bdCommissionDebit',
  INVITE_COMMISSION: 'inviteRewardPayout',
  INVITE_COMMISSION_CREDIT: 'inviteRewardPayout',
  USER_INVITE_COMMISSION_CREDIT: 'inviteRewardPayout',
  USER_INVITE_COMMISSION_DEBIT: 'inviteRewardDebit',
  FREEZE: 'assetFreeze',
  UNFREEZE: 'assetUnfreeze',
  ADJUST: 'platformAdjust',
  CONTRACT_OPEN_MARGIN: 'contractOpenMargin',
  OPEN_MARGIN_USED: 'contractOpenMargin',
  OPEN_MARGIN_FREEZE: 'contractOrderMarginFreeze',
  CONTRACT_MARGIN_RELEASE: 'contractMarginRelease',
  CLOSE_RELEASE: 'contractMarginRelease',
  CONTRACT_REALIZED_PNL: 'contractRealizedPnl',
  REALIZED_PNL: 'contractRealizedPnl',
  CONTRACT_SPREAD_FEE: 'contractSpreadCost',
  OPEN_FEE: 'contractOpenFee',
  CLOSE_FEE: 'contractCloseFee',
  CONTRACT_LIQUIDATION: 'liquidationDeduct',
  LIQUIDATION_ZERO: 'liquidationSettlement',
  CONTRACT_TRANSFER_IN: 'contractTransferIn',
  CONTRACT_TRANSFER_OUT: 'contractTransferOut',
  STOCK_TOKEN_CONVERT: 'stockTokenConvert',
};

const TECHNICAL_REMARK_PATTERNS = [
  /moralis/i,
  /\bfunding\b/i,
  /\bspot balance\b/i,
  /\bcontract balance\b/i,
  /\bwithdraw_watcher\b/i,
  /\bsource_type=/i,
  /\btransfer from\b/i,
  /\btransfer to\b/i,
  /\binternal transfer\b/i,
  /\bsettlement\b/i,
];

const TX_ID_PATTERN = /(0x[a-fA-F0-9]{32,}|[A-HJ-NP-Za-km-z1-9]{44,100})/;

function codeCandidates(item: BalanceLogItem) {
  return [item.biz_type, item.raw_biz_type]
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
}

function hasCode(item: BalanceLogItem, pattern: string) {
  return codeCandidates(item).some((code) => code.includes(pattern));
}

function exactCodeLabel(item: BalanceLogItem, t: AssetTranslator) {
  for (const code of codeCandidates(item)) {
    const labelKey = BALANCE_LOG_TYPE_LABEL_KEYS[code];
    if (labelKey) return t(labelKey, 'asset');
  }
  return '';
}

function formatBizType(item: BalanceLogItem, t: AssetTranslator) {
  const exactLabel = exactCodeLabel(item, t);
  if (exactLabel) return exactLabel;

  if (hasCode(item, 'CONTRACT_OPEN_MARGIN') || hasCode(item, 'OPEN_MARGIN_USED')) return t('contractOpenMargin', 'asset');
  if (hasCode(item, 'CONTRACT_MARGIN_RELEASE') || hasCode(item, 'CLOSE_RELEASE')) return t('contractMarginRelease', 'asset');
  if (hasCode(item, 'CONTRACT_REALIZED_PNL') || hasCode(item, 'REALIZED_PNL')) return t('contractRealizedPnl', 'asset');
  if (hasCode(item, 'CONTRACT_SPREAD_FEE')) return t('contractSpreadCost', 'asset');
  if (hasCode(item, 'CONTRACT_LIQUIDATION')) return t('liquidationDeduct', 'asset');
  if (hasCode(item, 'CONTRACT_TRANSFER')) return t('contractTransfer', 'asset');
  if (hasCode(item, 'BD_COMMISSION')) return t('bdCommissionPayout', 'asset');
  if (hasCode(item, 'USER_INVITE_COMMISSION') || hasCode(item, 'INVITE_COMMISSION')) return t('inviteRewardPayout', 'asset');
  if (hasCode(item, 'USER_TRANSFER_IN')) return t('internalTransferIn', 'asset');
  if (hasCode(item, 'USER_TRANSFER_OUT')) return t('internalTransferOut', 'asset');
  if (hasCode(item, 'WITHDRAW')) return t('withdraw', 'asset');
  if (hasCode(item, 'DEPOSIT')) return t('chainDepositArrived', 'asset');
  if (hasCode(item, 'TRADE_FEE')) return t('tradeFee', 'asset');
  if (hasCode(item, 'TRADE')) return t('tradeFundsChange', 'asset');
  if (hasCode(item, 'DIVIDEND')) return t('dividendPayout', 'asset');
  if (hasCode(item, 'STOCK_TOKEN_CONVERT')) return t('stockTokenConvert', 'asset');
  if (hasCode(item, 'UNFREEZE')) return t('assetUnfreeze', 'asset');
  if (hasCode(item, 'FREEZE')) return t('assetFreeze', 'asset');
  if (hasCode(item, 'ADJUST')) return t('platformAdjust', 'asset');
  if (hasCode(item, 'TRANSFER')) return t('accountTransfer', 'asset');

  return codeCandidates(item)[0] || '--';
}

function extractTxId(item: BalanceLogItem) {
  const remark = String(item.remark || '');
  const match = remark.match(TX_ID_PATTERN);
  return match?.[1] || '';
}

function shortenTxId(value: string) {
  const txid = value.trim();
  if (!txid) return '';
  if (txid.length <= 22) return txid;
  return `${txid.slice(0, 10)}...${txid.slice(-5)}`;
}

function cleanRemark(remark: string, txId: string, t: AssetTranslator) {
  let text = String(remark || '').trim();
  if (!text) return '';
  if (txId) text = text.replace(txId, '');
  text = text
    .replace(/moralis\s+deposit/gi, '')
    .replace(/#\d+/g, '')
    .replace(/\bfunding account\b/gi, t('fundingAccount', 'asset'))
    .replace(/\bspot balance\b/gi, t('spotAccount', 'asset'))
    .replace(/\bcontract balance\b/gi, t('contractAccount', 'asset'))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || TECHNICAL_REMARK_PATTERNS.some((pattern) => pattern.test(text))) return '';
  return text;
}

function formatLogTitle(item: BalanceLogItem, t: AssetTranslator) {
  if (hasCode(item, 'DEPOSIT')) {
    const networkLabel = accountLabel(item.chain_key, t);
    if (['BSC', 'Polygon', 'Avalanche C-Chain'].includes(networkLabel)) {
      return `${networkLabel} ${t('chainDepositArrived', 'asset')}`;
    }
    return t('chainDepositArrived', 'asset');
  }
  return formatBizType(item, t);
}

function getBalanceLogDisplay(item: BalanceLogItem, t: AssetTranslator) {
  const txId = extractTxId(item);
  const title = formatLogTitle(item, t);
  const remark = cleanRemark(item.remark || '', txId, t);
  return {
    title,
    typeLabel: formatBizType(item, t),
    accountLabel: accountLabel(item.chain_key, t),
    txId,
    txIdShort: shortenTxId(txId),
    remark: remark && remark !== title ? remark : '',
  };
}

function IconCopy() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" className="inline-block">
      <path
        fill="currentColor"
        d="M16 1H6a2 2 0 0 0-2 2v10h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" className="inline-block">
      <path fill="currentColor" d="M9 16.2 4.8 12 3.4 13.4 9 19 21 7 19.6 5.6z" />
    </svg>
  );
}

function trimNumber(value: number, maximumFractionDigits: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function formatAmount(value: string | number | null | undefined) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || Math.abs(num) < 1e-12) return '0';
  const abs = trimNumber(Math.abs(num), 8);
  return `${num > 0 ? '+' : '-'}${abs}`;
}

function formatBalance(value: string | number | null | undefined) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || Math.abs(num) < 1e-12) return '0';
  return trimNumber(num, 8);
}

function amountClass(value: string | number | null | undefined) {
  const num = Number(value || 0);
  if (num > 0) return 'text-[#00c087]';
  if (num < 0) return 'text-[#f6465d]';
  return 'text-white/70';
}

function displayTime(value: string | null | undefined) {
  return value && value.trim() ? value : '--';
}

export default function AssetHistoryPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [items, setItems] = useState<BalanceLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [bizType, setBizType] = useState('ALL');
  const [coinSymbol, setCoinSymbol] = useState('');
  const [accountKey, setAccountKey] = useState('');
  const [copiedKey, setCopiedKey] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({
    bizType: 'ALL',
    coinSymbol: '',
    accountKey: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const totalPages = useMemo(() => Math.max(Math.ceil(total / PAGE_SIZE), 1), [total]);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      setLoading(true);
      setError('');

      try {
        const data = await AssetsAPI.getBalanceLogs({
          page,
          page_size: PAGE_SIZE,
          biz_type: queryBizType(appliedFilters.bizType),
          coin_symbol: appliedFilters.coinSymbol,
          chain_key: appliedFilters.accountKey,
        });

        if (!alive) return;
        setItems(data.items);
        setTotal(data.total);
      } catch (err) {
        if (!alive) return;
        console.error('Failed to load balance logs:', err);
        setError(t('fundFlowLoadFailed', 'asset'));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();

    return () => {
      alive = false;
    };
  }, [page, appliedFilters, t]);

  const handleSearch = () => {
    setPage(1);
    setPageInput('1');
    setAppliedFilters({ bizType, coinSymbol, accountKey });
  };

  const goToPage = (nextPage: number) => {
    const safePage = Math.min(Math.max(nextPage, 1), totalPages);
    setPage(safePage);
    setPageInput(String(safePage));
  };

  const commitPageInput = () => {
    const parsed = Number.parseInt(pageInput, 10);
    const safePage = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), totalPages)
      : page;
    goToPage(safePage);
  };

  const copyText = async (text: string, key: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? '' : current));
    }, 1200);
  };

  return (
    <main className="min-h-screen bg-[#090d12] py-8 lg:flex">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="w-full px-4 lg:w-4/5">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">{t('fundFlowTitle', 'asset')}</h1>
          <p className="mt-2 text-sm text-white/50">
            {t('fundFlowDesc', 'asset')}
          </p>
        </div>

        <div className="mb-5 rounded-lg border border-white/10 bg-[#0e1117] p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-xs text-white/55">
              {t('type', 'asset')}
              <select
                value={bizType}
                onChange={(event) => setBizType(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-md border border-white/10 bg-[#111823] px-3 text-sm text-white outline-none focus:border-[#f0b90b]/70"
              >
                {BIZ_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey, 'asset')}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-white/55">
              {t('currency', 'asset')}
              <select
                value={coinSymbol}
                onChange={(event) => setCoinSymbol(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-md border border-white/10 bg-[#111823] px-3 text-sm text-white outline-none focus:border-[#f0b90b]/70"
              >
                {COIN_OPTIONS.map((symbol) => (
                  <option key={symbol || 'all'} value={symbol}>
                    {symbol || t('allCoins', 'asset')}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-white/55">
              {t('account', 'asset')}
              <select
                value={accountKey}
                onChange={(event) => setAccountKey(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-md border border-white/10 bg-[#111823] px-3 text-sm text-white outline-none focus:border-[#f0b90b]/70"
              >
                {ACCOUNT_OPTIONS.map((option) => (
                  <option key={option.value || 'all'} value={option.value}>
                    {t(option.labelKey, 'asset')}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end">
              <button
                type="button"
                onClick={handleSearch}
                className="h-10 w-full rounded-md bg-[#f0b90b] px-4 text-sm font-semibold text-[#111] hover:bg-[#f5c842]"
              >
                {t('search', 'common')}
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0e1117]">
          {loading ? (
            <div className="py-12 text-center text-white/60">{t('loadingFundFlow', 'asset')}</div>
          ) : error ? (
            <div className="py-12 text-center">
              <div className="text-red-300">{error}</div>
              <button
                type="button"
                onClick={handleSearch}
                className="mt-4 rounded-md bg-[#252b37] px-4 py-2 text-sm text-white hover:bg-[#323a48]"
              >
                {t('reload', 'asset')}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-white/55">{t('noFundFlow', 'asset')}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.02] text-xs text-white/45">
                      <th className="px-4 py-3 text-left font-medium">{t('time', 'asset')}</th>
                      <th className="px-4 py-3 text-left font-medium">{t('type', 'asset')}</th>
                      <th className="px-4 py-3 text-left font-medium">{t('currency', 'asset')}</th>
                      <th className="px-4 py-3 text-right font-medium">{t('amount', 'asset')}</th>
                      <th className="px-4 py-3 text-right font-medium">{t('balance', 'asset')}</th>
                      <th className="px-4 py-3 text-left font-medium">{t('status', 'asset')}</th>
                      <th className="px-4 py-3 text-left font-medium">{t('remark', 'asset')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const display = getBalanceLogDisplay(item, t);
                      const txCopyKey = `tx:${item.id}`;

                      return (
                        <tr
                          key={item.id}
                          className="border-b border-white/[0.06] text-sm last:border-0 hover:bg-white/[0.03]"
                        >
                          <td className="whitespace-nowrap px-4 py-4 text-white/60">
                            {displayTime(item.created_at)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4 text-white">
                            {display.typeLabel}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4 text-white/70">
                            {item.coin_symbol || '--'}
                          </td>
                          <td className={`whitespace-nowrap px-4 py-4 text-right tabular-nums ${amountClass(item.change_amount)}`}>
                            {formatAmount(item.change_amount)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4 text-right text-white/70 tabular-nums">
                            {formatBalance(item.after_available)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4">
                            <span className="inline-flex rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-200">
                              {t('completed', 'asset')}
                            </span>
                          </td>
                          <td className="min-w-[240px] px-4 py-4 text-white/55">
                            <div className="font-medium text-white/80">{display.title}</div>
                            {display.remark ? (
                              <div className="mt-1 line-clamp-2 text-xs text-white/45">{display.remark}</div>
                            ) : null}
                            <div className="mt-1 text-xs text-white/35">{display.accountLabel}</div>
                            {display.txId ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-2 py-0.5 font-mono text-[11px] text-[#f0b90b]">
                                  TxID {display.txIdShort}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => copyText(display.txId, txCopyKey)}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/[0.03] text-white/55 hover:border-[#f0b90b]/50 hover:text-[#f0b90b]"
                                  title={copiedKey === txCopyKey ? t('copied', 'asset') : t('copyTxId', 'asset')}
                                  aria-label={t('copyTxId', 'asset')}
                                >
                                  {copiedKey === txCopyKey ? <IconCheck /> : <IconCopy />}
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] px-4 py-3">
                <div className="text-sm text-white/45">{t('totalRecordsPrefix', 'asset')} {total} {t('totalRecordsSuffix', 'asset')}</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => goToPage(page - 1)}
                    className="rounded border border-white/10 bg-[#0f1319] px-3 py-1 text-white/70 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('prevPage', 'asset')}
                  </button>
                  <div className="flex items-center gap-2 text-sm text-white/60">
                    <input
                      value={pageInput}
                      onChange={(event) => setPageInput(event.target.value)}
                      onBlur={commitPageInput}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitPageInput();
                      }}
                      className="w-14 rounded border border-white/10 bg-[#0f1319] px-2 py-1 text-center text-white outline-none focus:border-[#f0b90b]/70"
                    />
                    <span>/ {totalPages}</span>
                  </div>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => goToPage(page + 1)}
                    className="rounded border border-white/10 bg-[#0f1319] px-3 py-1 text-white/70 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('nextPage', 'asset')}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
