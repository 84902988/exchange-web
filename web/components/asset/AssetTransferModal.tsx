'use client';

import { useEffect, useMemo, useState } from 'react';

import AssetsAPI, { type AccountBalanceItem } from '@/lib/api/modules/assets';
import TransferAPI from '@/lib/api/modules/transfer';
import {
  getContractAccountSummary,
  transferInContract,
  transferOutContract,
} from '@/lib/api/modules/contract';
import { friendlyContractError, toNumber } from '@/components/contract/contractFormat';
import { useLocaleContext } from '@/contexts/LocaleContext';

type AccountKey = 'funding' | 'spot' | 'contract';

type AssetTransferModalProps = {
  open: boolean;
  onClose: () => void;
  defaultFrom?: AccountKey;
  defaultTo?: AccountKey;
  defaultCoin?: string;
  onSuccess?: () => void | Promise<void>;
};

const accountOptions: AccountKey[] = ['funding', 'spot', 'contract'];
const percentOptions = [25, 50, 75, 100];

const accountLabelKeys: Record<AccountKey, string> = {
  funding: 'fundingAccount',
  spot: 'spotAccount',
  contract: 'contractAccount',
};

type AssetTranslator = (key: string, namespace?: 'asset' | 'common') => string;

function getAccountLabel(account: AccountKey, t: AssetTranslator) {
  return t(accountLabelKeys[account], 'asset');
}

const supportedRoutes: Array<[AccountKey, AccountKey]> = [
  ['funding', 'spot'],
  ['spot', 'funding'],
  ['funding', 'contract'],
  ['contract', 'funding'],
];

function fmtBalance(value: string | null) {
  if (value === null) return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function normalizeCoin(value?: string) {
  return (value || 'USDT').trim().toUpperCase() || 'USDT';
}

function isSupportedRoute(from: AccountKey, to: AccountKey) {
  return supportedRoutes.some(([routeFrom, routeTo]) => routeFrom === from && routeTo === to);
}

function normalizeRoute(from: AccountKey, to: AccountKey): { from: AccountKey; to: AccountKey } {
  if (isSupportedRoute(from, to)) {
    return { from, to };
  }

  const nextTo = accountOptions.find((item) => item !== from && isSupportedRoute(from, item));
  if (nextTo) {
    return { from, to: nextTo };
  }

  const nextFrom = accountOptions.find((item) => item !== to && isSupportedRoute(item, to));
  if (nextFrom) {
    return { from: nextFrom, to };
  }

  return { from: 'funding', to: 'spot' };
}

function isContractRoute(from: AccountKey, to: AccountKey) {
  return (
    (from === 'funding' && to === 'contract') ||
    (from === 'contract' && to === 'funding')
  );
}

function getBalanceAccount(item: AccountBalanceItem) {
  return String(item.account_key || item.account_type || item.chain_key || item.network_code || '')
    .trim()
    .toLowerCase();
}

function getBalanceCoin(item: AccountBalanceItem) {
  return String(item.coin_symbol || item.symbol || '').trim().toUpperCase();
}

function getBalanceAvailable(item: AccountBalanceItem) {
  return String(item.available_amount ?? item.available ?? '0');
}

function coinDotClass(symbol: string) {
  const normalized = normalizeCoin(symbol);
  if (normalized === 'USDT') return 'bg-[#26a17b]';
  if (normalized === 'BTC') return 'bg-[#f7931a]';
  if (normalized === 'ETH') return 'bg-[#627eea]';
  return 'bg-[#f0b90b]';
}

export default function AssetTransferModal({
  open,
  onClose,
  defaultFrom = 'funding',
  defaultTo = 'spot',
  defaultCoin = 'USDT',
  onSuccess,
}: AssetTransferModalProps) {
  const { t } = useLocaleContext();
  const [from, setFrom] = useState<AccountKey>(defaultFrom);
  const [to, setTo] = useState<AccountKey>(defaultTo);
  const [coin, setCoin] = useState(normalizeCoin(defaultCoin));
  const [amount, setAmount] = useState('');
  const [coinMenuOpen, setCoinMenuOpen] = useState(false);
  const [balanceRows, setBalanceRows] = useState<AccountBalanceItem[]>([]);
  const [available, setAvailable] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const availableNumber = useMemo(() => {
    if (available === null) return null;
    const n = toNumber(available);
    return Number.isFinite(n) ? n : null;
  }, [available]);
  const selectedPercent = useMemo(() => {
    if (availableNumber === null || availableNumber <= 0) return null;
    const current = toNumber(amount);
    if (!Number.isFinite(current) || current <= 0) return null;
    return (
      percentOptions.find(
        (percent) => Math.abs(current - (availableNumber * percent) / 100) < 0.00000001,
      ) || null
    );
  }, [amount, availableNumber]);
  const routeIsContract = isContractRoute(from, to);
  const coinOptions = useMemo(() => {
    if (routeIsContract) {
      return [{ symbol: 'USDT', available: available ?? null }];
    }

    const map = new Map<string, { symbol: string; available: string | null }>();
    balanceRows.forEach((item) => {
      if (getBalanceAccount(item) !== from) return;
      const symbol = getBalanceCoin(item);
      if (!symbol || map.has(symbol)) return;
      map.set(symbol, {
        symbol,
        available: getBalanceAvailable(item),
      });
    });

    const rows = Array.from(map.values()).sort((a, b) => {
      if (a.symbol === 'USDT') return -1;
      if (b.symbol === 'USDT') return 1;
      return a.symbol.localeCompare(b.symbol);
    });

    return rows.length > 0 ? rows : [{ symbol: normalizeCoin(defaultCoin), available: null }];
  }, [available, balanceRows, defaultCoin, from, routeIsContract]);
  const routeHint = routeIsContract
    ? t('contractUsdtOnlyHint', 'asset')
    : coin !== 'USDT' && to === 'funding'
      ? t('transferToFundingWithdrawHint', 'asset')
      : coin !== 'USDT'
        ? t('transferToSpotTradeHint', 'asset')
        : t('fundingSpotTransferHint', 'asset');

  useEffect(() => {
    if (!open) return;
    const initialRoute = normalizeRoute(defaultFrom, defaultTo);
    setFrom(initialRoute.from);
    setTo(initialRoute.to);
    setCoin(normalizeCoin(defaultCoin));
    setAmount('');
    setCoinMenuOpen(false);
    setError('');
    setSuccess('');
  }, [defaultCoin, defaultFrom, defaultTo, open]);

  useEffect(() => {
    if (!open) return;
    const nextCoin = coinOptions.some((item) => item.symbol === coin)
      ? coin
      : coinOptions[0]?.symbol || 'USDT';
    if (nextCoin !== coin) {
      setCoin(nextCoin);
      setAmount('');
      setError('');
      setSuccess('');
    }
  }, [coin, coinOptions, open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;

    async function loadAvailable() {
      setLoadingBalance(true);
      setAvailable(null);
      try {
        const rows = await AssetsAPI.getAccountBalances();
        if (alive) setBalanceRows(rows);

        if (from === 'contract') {
          const account = await getContractAccountSummary();
          if (alive) setAvailable(coin === 'USDT' ? account.available_margin || '0' : '0');
          return;
        }

        const row = rows.find(
          (item) =>
            getBalanceAccount(item) === from &&
            getBalanceCoin(item) === coin,
        );
        if (alive) setAvailable(row ? getBalanceAvailable(row) : '0');
      } catch {
        if (alive) setAvailable(null);
      } finally {
        if (alive) setLoadingBalance(false);
      }
    }

    void loadAvailable();
    return () => {
      alive = false;
    };
  }, [coin, from, open]);

  if (!open) return null;

  function setPercent(percent: number) {
    if (availableNumber === null) return;
    const next = (availableNumber * percent) / 100;
    setAmount(next > 0 ? String(next) : '');
  }

  function useMax() {
    if (availableNumber === null) return;
    setAmount(availableNumber > 0 ? String(availableNumber) : '');
  }

  function selectCoinOption(symbol: string) {
    setCoin(symbol);
    setCoinMenuOpen(false);
    setAmount('');
    setError('');
    setSuccess('');
  }

  function swapAccounts() {
    setFrom(to);
    setTo(from);
    setAmount('');
    setError('');
    setSuccess('');
  }

  async function submit() {
    const transferAmount = toNumber(amount);
    setError('');
    setSuccess('');

    if (from === to) {
      setError(t('sameAccountTransferError', 'asset'));
      return;
    }
    if (!isSupportedRoute(from, to)) {
      setError(t('unsupportedTransferRoute', 'asset'));
      return;
    }
    if (isContractRoute(from, to) && coin !== 'USDT') {
      setError(t('contractUsdtOnlyError', 'asset'));
      return;
    }
    if (transferAmount <= 0) {
      setError(t('invalidTransferAmount', 'asset'));
      return;
    }
    if (availableNumber !== null && transferAmount > availableNumber) {
      setError(t('insufficientTransferBalance', 'asset'));
      return;
    }

    setSubmitting(true);
    try {
      if (from === 'funding' && to === 'contract') {
        await transferInContract(amount);
      } else if (from === 'contract' && to === 'funding') {
        await transferOutContract(amount);
      } else if (
        (from === 'funding' && to === 'spot') ||
        (from === 'spot' && to === 'funding')
      ) {
        await TransferAPI.createTransfer({
          from_account: from,
          to_account: to,
          symbol: coin,
          amount,
        });
      } else {
        setError(t('unsupportedTransferRoute', 'asset'));
        return;
      }

      setSuccess(t('transferSuccess', 'asset'));
      await onSuccess?.();
      await new Promise((resolve) => {
        window.setTimeout(resolve, 350);
      });
      onClose();
    } catch (err) {
      setError(friendlyContractError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-4 backdrop-blur-sm">
      <div className="max-h-[calc(100vh-32px)] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-white/10 bg-[#151a21] tabular-nums text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h3 className="text-[18px] font-semibold">{t('transferFunds', 'asset')}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeTransferModal', 'asset')}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[20px] leading-none text-white/55 transition hover:bg-white/[0.08] hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 p-5">
          <AccountSelect
            label={t('fromAccount', 'asset')}
            value={from}
            disabledValue={to}
            isOptionDisabled={(item) => item === to || !isSupportedRoute(item, to)}
            onChange={(next) => {
              const nextRoute = normalizeRoute(next, to);
              setFrom(nextRoute.from);
              setTo(nextRoute.to);
              setAmount('');
              setCoinMenuOpen(false);
              setError('');
              setSuccess('');
            }}
          />
          <div className="flex justify-center">
            <button
              type="button"
              onClick={swapAccounts}
              aria-label={t('swapTransferAccounts', 'asset')}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-[#0d1218] text-[18px] text-white/70 transition hover:border-[#f0b90b]/50 hover:bg-[#f0b90b]/10 hover:text-[#f0b90b]"
            >
              ⇅
            </button>
          </div>
          <AccountSelect
            label={t('toAccount', 'asset')}
            value={to}
            disabledValue={from}
            isOptionDisabled={(item) => item === from || !isSupportedRoute(from, item)}
            onChange={(next) => {
              const nextRoute = normalizeRoute(from, next);
              setFrom(nextRoute.from);
              setTo(nextRoute.to);
              setAmount('');
              setCoinMenuOpen(false);
              setError('');
              setSuccess('');
            }}
          />

          <div className="block">
            <span className="mb-1.5 block text-[12px] text-white/45">{t('coin', 'asset')}</span>
            <div className="relative">
              <button
                type="button"
                onClick={() => setCoinMenuOpen((value) => !value)}
                className="flex h-12 w-full items-center rounded-xl border border-white/[0.08] bg-[#0d1218] px-3 text-left text-white outline-none transition hover:border-white/15 focus:border-[#f0b90b]/60"
              >
                <span
                  className={`mr-3 h-5 w-5 rounded-full shadow-[0_0_0_3px_rgba(240,185,11,0.12)] ${coinDotClass(coin)}`}
                />
                <span className="flex-1 text-[15px] font-semibold">{coin}</span>
                <span className="text-[12px] text-white/35">▼</span>
              </button>
              {coinMenuOpen ? (
                <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-xl border border-[#2a2f3a] bg-[#0f172a] py-1 text-white shadow-2xl">
                  {coinOptions.map((item) => (
                    <button
                      key={item.symbol}
                      type="button"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectCoinOption(item.symbol);
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        selectCoinOption(item.symbol);
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-[14px] text-white transition hover:bg-[#1f2937] ${
                        coin === item.symbol ? 'bg-[#374151]' : ''
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className={`h-5 w-5 rounded-full ${coinDotClass(item.symbol)}`} />
                        <span className="font-semibold">{item.symbol}</span>
                      </span>
                      <span className="text-[12px] font-medium tabular-nums text-white/45">
                        {fmtBalance(item.available)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="mt-1.5 text-[12px] text-white/45">
              {routeHint}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="text-white/45">{t('quantity', 'asset')}</span>
              <span className="font-medium tabular-nums text-white/45">
                {t('transferable', 'asset')}: {loadingBalance ? t('loading', 'common') : `${fmtBalance(available)} ${coin}`}
              </span>
            </div>
            <div
              className={`flex h-12 items-center rounded-xl border bg-[#0d1218] px-3 transition ${
                error ? 'border-[#f6465d]/70' : 'border-white/[0.08] focus-within:border-[#f0b90b]/60'
              }`}
            >
              <input
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setError('');
                  setSuccess('');
                }}
                className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold tabular-nums text-white outline-none placeholder:text-white/22"
                placeholder={t('transferAmountPlaceholder', 'asset')}
              />
              <button
                type="button"
                onClick={useMax}
                disabled={availableNumber === null}
                className="ml-2 rounded-md px-2 py-1 text-[12px] font-semibold text-[#f0b90b] transition hover:bg-[#f0b90b]/10 disabled:text-white/25 disabled:hover:bg-transparent"
              >
                {t('maxAmount', 'asset')}
              </button>
            </div>
            {error ? <div className="mt-1.5 text-[12px] text-[#f6465d]">{error}</div> : null}
          </div>

          <div className="grid grid-cols-4 gap-2">
            {percentOptions.map((percent) => (
              <button
                key={percent}
                type="button"
                disabled={availableNumber === null}
                onClick={() => setPercent(percent)}
                className={`h-8 rounded-lg border text-[12px] font-medium tabular-nums transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  selectedPercent === percent
                    ? 'border-[#f0b90b]/50 bg-[#f0b90b]/10 text-[#f0b90b]'
                    : 'border-white/10 text-white/65 hover:border-white/25 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {percent}%
              </button>
            ))}
          </div>

          {success ? (
            <div className="min-h-4 text-[12px] text-[#00c087]">
              {success}
            </div>
          ) : null}

          <div className="text-center text-[12px] text-white/45">
            {routeHint}
          </div>

          <button
            type="button"
            disabled={submitting || loadingBalance}
            onClick={submit}
            className="h-12 w-full rounded-xl bg-[#f0b90b] text-[15px] font-semibold text-black transition hover:bg-[#f6c62f] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#f0b90b]"
          >
            {submitting ? t('transferring', 'asset') : t('confirmTransfer', 'asset')}
          </button>
        </div>
      </div>
    </div>
  );
}

function AccountSelect({
  label,
  value,
  disabledValue,
  isOptionDisabled,
  onChange,
}: {
  label: string;
  value: AccountKey;
  disabledValue: AccountKey;
  isOptionDisabled?: (value: AccountKey) => boolean;
  onChange: (value: AccountKey) => void;
}) {
  const { t } = useLocaleContext();
  const [open, setOpen] = useState(false);

  function selectAccount(next: AccountKey) {
    if (next === disabledValue || isOptionDisabled?.(next)) return;
    onChange(next);
    setOpen(false);
  }

  return (
    <div className="relative rounded-xl border border-white/[0.08] bg-[#0d1218] px-4 py-3 transition hover:border-white/15">
      <span className="block text-[12px] text-white/45">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((next) => !next)}
        className="mt-1 flex h-8 w-full items-center justify-between gap-3 text-left outline-none"
      >
        <span className="text-[16px] font-semibold text-white">{getAccountLabel(value, t)}</span>
        <span className="text-[12px] text-white/35">▼</span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-xl border border-[#2a2f3a] bg-[#0f172a] py-1 text-white shadow-2xl">
          {accountOptions.map((item) => (
            <button
              key={item}
              type="button"
              disabled={item === disabledValue || Boolean(isOptionDisabled?.(item))}
              onClick={() => selectAccount(item)}
              className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-[14px] transition ${
                item === value
                  ? 'bg-[#374151] text-white'
                  : 'text-white/80 hover:bg-[#1f2937] hover:text-white'
              } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent`}
            >
              <span>{getAccountLabel(item, t)}</span>
              {item === value ? <span className="text-[#f0b90b]">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
