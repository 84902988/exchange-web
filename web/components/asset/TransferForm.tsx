'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type AccountBalanceItem, type CoinItem } from '@/lib/api/modules/assets';
import TransferAPI, {
  type TransferAccountKey,
  type TransferRecordItem,
} from '@/lib/api/modules/transfer';
import { useLocaleContext } from '@/contexts/LocaleContext';

type TransferFormProps = {
  accountBalances?: AccountBalanceItem[];
  coins?: CoinItem[];
  onSuccess?: () => void | Promise<void>;
};

type AssetTranslator = (key: string, namespace?: 'asset' | 'common') => string;

function safeNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function getDisplayPrecision(symbol: string, coin?: CoinItem): number {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const coinPrecision = Number(coin?.display_precision);

  if (normalizedSymbol === 'USDT') {
    return 2;
  }

  if (normalizedSymbol === 'BTC' || normalizedSymbol === 'ETH') {
    if (Number.isFinite(coinPrecision) && coinPrecision > 0) {
      return Math.min(Math.max(coinPrecision, 4), 6);
    }
    return 6;
  }

  if (Number.isFinite(coinPrecision) && coinPrecision > 0) {
    return coinPrecision;
  }

  return 4;
}

function formatAmount(value: number, precision: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', {
    hour12: false,
  });
}

function formatMessage(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template
  );
}

function getAccountLabel(account: string, t: AssetTranslator) {
  const labels: Record<string, string> = {
    funding: t('fundingAccount', 'asset'),
    spot: t('spotAccount', 'asset'),
    contract: t('contractAccount', 'asset'),
  };
  return labels[String(account || '').toLowerCase()] || account || '--';
}

function getTransferStatusLabel(status: string, t: AssetTranslator) {
  const normalized = String(status || '').trim().toUpperCase();
  const labelKeys: Record<string, string> = {
    PENDING: 'transferStatusPending',
    SUCCESS: 'transferStatusSuccess',
    FAILED: 'transferStatusFailed',
    CANCELLED: 'transferStatusCanceled',
    CANCELED: 'transferStatusCanceled',
    PROCESSING: 'transferStatusProcessing',
  };
  const labelKey = labelKeys[normalized];
  return labelKey ? t(labelKey, 'asset') : '--';
}

function formatTransferDirection(fromAccount: string, toAccount: string, t: AssetTranslator) {
  return `${getAccountLabel(fromAccount, t)} -> ${getAccountLabel(toAccount, t)}`;
}

export default function TransferForm({
  accountBalances = [],
  coins = [],
  onSuccess,
}: TransferFormProps) {
  const { t } = useLocaleContext();
  const [fromAccount, setFromAccount] = useState<TransferAccountKey>('funding');
  const [toAccount, setToAccount] = useState<TransferAccountKey>('spot');
  const [symbol, setSymbol] = useState('USDT');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [records, setRecords] = useState<TransferRecordItem[]>([]);
  const [error, setError] = useState('');

  const normalizedSymbol = useMemo(() => {
    return symbol.trim().toUpperCase() || 'USDT';
  }, [symbol]);

  const selectedCoin = useMemo(() => {
    return coins.find((item) => item.symbol === normalizedSymbol);
  }, [coins, normalizedSymbol]);

  const displayPrecision = useMemo(() => {
    return getDisplayPrecision(normalizedSymbol, selectedCoin);
  }, [normalizedSymbol, selectedCoin]);

  const availableBalance = useMemo(() => {
    return accountBalances.reduce((sum, item) => {
      if (item.symbol !== normalizedSymbol) return sum;
      if (item.account_key !== fromAccount) return sum;
      return sum + safeNum(item.available);
    }, 0);
  }, [accountBalances, fromAccount, normalizedSymbol]);

  const parsedAmount = useMemo(() => {
    return safeNum(amount.trim());
  }, [amount]);

  const validationError = useMemo(() => {
    if (fromAccount === toAccount) {
      return t('sameAccountTransferError', 'asset');
    }

    if (availableBalance <= 0) {
      return formatMessage(t('transferCurrentBalanceZero', 'asset'), {
        account: getAccountLabel(fromAccount, t),
        symbol: normalizedSymbol,
      });
    }

    if (!amount.trim()) {
      return t('transferAmountPlaceholder', 'asset');
    }

    if (parsedAmount <= 0) {
      return t('invalidTransferAmount', 'asset');
    }

    if (parsedAmount > availableBalance) {
      return t('transferAmountExceedsAvailable', 'asset');
    }

    return '';
  }, [amount, availableBalance, fromAccount, normalizedSymbol, parsedAmount, t, toAccount]);

  const loadRecords = useCallback(async () => {
    try {
      setRecordsLoading(true);
      const data = await TransferAPI.getTransferRecords({
        page: 1,
        page_size: 20,
      });
      setRecords(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setError(t('transferRecordsLoadFailed', 'asset'));
    } finally {
      setRecordsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    if (!error) return;
    if (!validationError) return;
    setError(validationError);
  }, [validationError, error]);

  const handleSubmit = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setSubmitting(true);

    try {
      await TransferAPI.createTransfer({
        from_account: fromAccount,
        to_account: toAccount,
        symbol: normalizedSymbol,
        amount: amount.trim(),
      });

      window.alert(t('transferSuccess', 'asset'));
      setAmount('');

      await loadRecords();
      await onSuccess?.();
    } catch {
      setError(t('transferFailed', 'asset'));
    } finally {
      setSubmitting(false);
    }
  };

  const isSubmitDisabled = submitting || Boolean(validationError);

  return (
    <div
      id="asset-transfer-form"
      className="bg-[#0e1117] rounded-xl p-5 border border-white/10 shadow-xl mt-6"
    >
      <h2 className="text-lg font-semibold text-white mb-2">{t('accountTransfer', 'asset')}</h2>

      <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 text-sm text-white/70">
        <div>{t('fundingAccountDesc', 'asset')}</div>
        <div className="mt-1">{t('spotAccountDesc', 'asset')}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
        <select
          className="bg-[#1a1f2e] border border-white/10 rounded-lg px-3 py-2 text-white"
          value={fromAccount}
          onChange={(e) => {
            setFromAccount(e.target.value as TransferAccountKey);
            setError('');
          }}
          disabled={submitting}
        >
          <option value="funding">{t('fundingAccount', 'asset')}</option>
          <option value="spot">{t('spotAccount', 'asset')}</option>
        </select>

        <select
          className="bg-[#1a1f2e] border border-white/10 rounded-lg px-3 py-2 text-white"
          value={toAccount}
          onChange={(e) => {
            setToAccount(e.target.value as TransferAccountKey);
            setError('');
          }}
          disabled={submitting}
        >
          <option value="funding">{t('fundingAccount', 'asset')}</option>
          <option value="spot">{t('spotAccount', 'asset')}</option>
        </select>

        <input
          className="bg-[#1a1f2e] border border-white/10 rounded-lg px-3 py-2 text-white"
          value={symbol}
          onChange={(e) => {
            setSymbol(e.target.value.toUpperCase());
            setError('');
          }}
          placeholder={t('transferSymbolPlaceholder', 'asset')}
          disabled={submitting}
        />

        <input
          className="bg-[#1a1f2e] border border-white/10 rounded-lg px-3 py-2 text-white"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setError('');
          }}
          placeholder={t('transferAmountPlaceholder', 'asset')}
          disabled={submitting}
        />
      </div>

      <div className="mb-3 rounded-lg border border-white/10 bg-[#121826] px-3 py-3 text-sm text-white/75">
        <div className="font-medium text-white">
          {formatMessage(t('transferCurrentAvailableBalance', 'asset'), {
            amount: formatAmount(availableBalance, displayPrecision),
            symbol: normalizedSymbol,
          })}
        </div>
        <div className="mt-1 text-white/60">
          {formatMessage(t('transferCurrentFromAccount', 'asset'), {
            account: getAccountLabel(fromAccount, t),
          })}
        </div>
        <div className="mt-1 text-white/60">
          {formatMessage(t('transferInstruction', 'asset'), {
            from: getAccountLabel(fromAccount, t),
            to: getAccountLabel(toAccount, t),
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <button
          type="button"
          className="px-4 py-2 bg-amber-600 text-white rounded-lg disabled:opacity-50"
          onClick={handleSubmit}
          disabled={isSubmitDisabled}
        >
          {submitting ? t('transferSubmitting', 'asset') : t('transferSubmit', 'asset')}
        </button>

        <div className="text-sm text-white/55">
          {t('transferToSpotTradeHint', 'asset')}
        </div>
      </div>

      {error || validationError ? (
        <div className="mt-3 text-sm text-red-400">{error || validationError}</div>
      ) : null}

      <div className="mt-6">
        <h3 className="text-base font-medium text-white mb-3">{t('transferRecords', 'asset')}</h3>

        {recordsLoading ? (
          <div className="text-sm text-zinc-400">{t('loading', 'common')}</div>
        ) : records.length === 0 ? (
          <div className="text-sm text-zinc-400">{t('noTransferRecords', 'asset')}</div>
        ) : (
          <div className="space-y-2">
            {records.map((item) => (
              <div
                key={item.transfer_no}
                className="border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
              >
                <div>{`${item.symbol} | ${formatTransferDirection(item.from_account, item.to_account, t)}`}</div>
                <div className="text-zinc-400">
                  {`${t('transferRecordAmountLabel', 'asset')}: ${formatAmount(safeNum(item.amount), getDisplayPrecision(item.symbol, coins.find((coin) => coin.symbol === item.symbol)))}`}
                </div>
                <div className="text-zinc-400">{`${t('transferRecordStatusLabel', 'asset')}: ${getTransferStatusLabel(item['status'], t)}`}</div>
                <div className="text-zinc-400">{formatTime(item.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
