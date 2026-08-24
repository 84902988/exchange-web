import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ArrowDownUp, ChevronRight } from 'lucide-react-native';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  AuthRequiredCard,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SelectChips,
  StateCard,
  formatAmount,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import {
  fetchAssetAccountBalances,
  submitContractTransfer,
  submitFundingSpotTransfer,
  type AssetAccountBalance,
  type AssetTransferAccountKey,
} from '../../api/assets';
import { useAuth } from '../../store/authStore';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';
import {
  compareNonNegativeDecimalText,
  isPositiveDecimalText,
  multiplyDecimalTextByPercent,
} from '../../utils/decimalText';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

const accounts: AssetTransferAccountKey[] = ['funding', 'spot', 'contract'];
const percents = [25, 50, 75, 100];

export default function TransferScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { isLoggedIn } = useAuth();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [balances, setBalances] = useState<AssetAccountBalance[]>([]);
  const [from, setFrom] = useState<AssetTransferAccountKey>('funding');
  const [to, setTo] = useState<AssetTransferAccountKey>('spot');
  const [coin, setCoin] = useState('USDT');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mountedRef = useRef(true);
  const balancesControllerRef = useRef<AbortController | null>(null);
  const balancesGenerationRef = useRef(0);
  const balancesLoadLockRef = useRef(false);
  const submitLockRef = useRef(false);

  const loadBalances = useCallback(async () => {
    if (!isLoggedIn || !mountedRef.current || balancesLoadLockRef.current) {
      return;
    }
    balancesLoadLockRef.current = true;
    const generation = ++balancesGenerationRef.current;
    const controller = new AbortController();
    balancesControllerRef.current?.abort();
    balancesControllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchAssetAccountBalances({
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== balancesGenerationRef.current
      ) {
        return;
      }
      setBalances(result);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== balancesGenerationRef.current
      ) {
        return;
      }
      setBalances([]);
      setError(
        toChineseError(
          requestError,
          tRef.current('transfer.loadFailed'),
          tRef.current,
        ),
      );
    } finally {
      if (generation === balancesGenerationRef.current) {
        balancesLoadLockRef.current = false;
        if (balancesControllerRef.current === controller) {
          balancesControllerRef.current = null;
        }
        if (mountedRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    }
  }, [isLoggedIn]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isLoggedIn) {
      setBalances([]);
      setError('');
      return undefined;
    }
    loadBalances().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      balancesGenerationRef.current += 1;
      balancesLoadLockRef.current = false;
      balancesControllerRef.current?.abort();
      balancesControllerRef.current = null;
    };
  }, [isLoggedIn, loadBalances]);

  const routeSupported = isSupportedRoute(from, to);
  const contractRoute = isContractRoute(from, to);

  const toOptions = useMemo(
    () =>
      accounts.map(account => ({
        value: account,
        label: accountLabel(account, t),
        disabled: account === from || !isSupportedRoute(from, account),
      })),
    [from, t],
  );

  const coinOptions = useMemo(() => {
    if (!routeSupported) return [];
    if (contractRoute) return [{ value: 'USDT', label: 'USDT' }];
    const rows = balances
      .filter(item => item.accountKey.toLowerCase() === from)
      .filter(item =>
        isPositiveDecimalText(item.availableText ?? item.available ?? 0),
      )
      .map(item => item.symbol.toUpperCase());
    return Array.from(new Set(rows))
      .sort((a, b) => {
        if (a === 'USDT') return -1;
        if (b === 'USDT') return 1;
        return a.localeCompare(b);
      })
      .map(symbol => ({ value: symbol, label: symbol }));
  }, [balances, contractRoute, from, routeSupported]);

  const selectedCoin = useMemo(() => {
    if (contractRoute) return 'USDT';
    if (coinOptions.some(item => item.value === coin)) return coin;
    return coinOptions[0]?.value ?? '';
  }, [coin, coinOptions, contractRoute]);

  const availableBalance = useMemo(() => {
    const row = balances.find(
      item =>
        item.accountKey.toLowerCase() === from &&
        item.symbol.toUpperCase() === selectedCoin,
    );
    const available = row?.available ?? 0;
    return {
      text:
        row?.availableText ??
        (Number.isFinite(available) ? String(available) : '0'),
    };
  }, [balances, from, selectedCoin]);

  const amountValid = isPositiveDecimalText(amount);
  const amountExceedsAvailable =
    compareNonNegativeDecimalText(amount, availableBalance.text) === 1;
  const submitDisabled =
    submitting ||
    !routeSupported ||
    !selectedCoin ||
    !amountValid ||
    amountExceedsAvailable;

  useEffect(() => {
    if (selectedCoin !== coin) {
      setCoin(selectedCoin);
      setAmount('');
    }
  }, [coin, selectedCoin]);

  const changeFrom = useCallback(
    (nextFrom: string) => {
      const normalized = nextFrom as AssetTransferAccountKey;
      const nextTo = isSupportedRoute(normalized, to)
        ? to
        : accounts.find(account => isSupportedRoute(normalized, account)) ??
          'spot';
      setFrom(normalized);
      setTo(nextTo);
      setAmount('');
      setError('');
      setMessage('');
    },
    [to],
  );

  const changeTo = useCallback((nextTo: string) => {
    setTo(nextTo as AssetTransferAccountKey);
    setAmount('');
    setError('');
    setMessage('');
  }, []);

  const swap = useCallback(() => {
    if (!isSupportedRoute(to, from)) return;
    setFrom(to);
    setTo(from);
    setAmount('');
    setError('');
    setMessage('');
  }, [from, to]);

  const setPercent = useCallback(
    (percent: number) => {
      if (!isPositiveDecimalText(availableBalance.text)) {
        setAmount('');
        return;
      }
      setAmount(
        multiplyDecimalTextByPercent(availableBalance.text, percent) ?? '',
      );
      setError('');
      setMessage('');
    },
    [availableBalance.text],
  );

  const submit = useCallback(async () => {
    if (submitLockRef.current) return;
    setError('');
    setMessage('');
    if (!routeSupported) {
      setError(tRef.current('transfer.unsupported'));
      return;
    }
    if (!selectedCoin) {
      setError(tRef.current('transfer.noCoins'));
      return;
    }
    if (contractRoute && selectedCoin !== 'USDT') {
      setError(tRef.current('transfer.contractUsdtOnly'));
      return;
    }
    if (!amountValid) {
      setError(tRef.current('transfer.invalidAmount'));
      return;
    }
    if (amountExceedsAvailable) {
      setError(tRef.current('transfer.insufficient'));
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);
    try {
      if (from === 'funding' && to === 'spot') {
        await submitFundingSpotTransfer({
          fromAccount: 'funding',
          toAccount: 'spot',
          symbol: selectedCoin,
          amount,
        });
      } else if (from === 'spot' && to === 'funding') {
        await submitFundingSpotTransfer({
          fromAccount: 'spot',
          toAccount: 'funding',
          symbol: selectedCoin,
          amount,
        });
      } else if (from === 'funding' && to === 'contract') {
        await submitContractTransfer({ direction: 'in', amount });
      } else if (from === 'contract' && to === 'funding') {
        await submitContractTransfer({ direction: 'out', amount });
      } else {
        setError(tRef.current('transfer.unsupported'));
        return;
      }
      if (mountedRef.current) {
        setMessage(tRef.current('transfer.success'));
        setAmount('');
        await loadBalances();
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          toChineseError(
            requestError,
            tRef.current('transfer.failed'),
            tRef.current,
          ),
        );
      }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    amount,
    amountValid,
    amountExceedsAvailable,
    contractRoute,
    from,
    loadBalances,
    routeSupported,
    selectedCoin,
    to,
  ]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('transfer.title')}
        subtitle={t('transfer.subtitle')}
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={loadBalances} />}
      />

      {isLoggedIn ? (
        <Pressable
          accessibilityLabel={t('transfer.recordsA11y')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          style={({ pressed }) => [
            styles.userTransferEntry,
            pressed ? styles.pressed : null,
          ]}
          onPress={() => navigation.navigate('UserTransferRecords')}
        >
          <View style={styles.userTransferEntryText}>
            <Text style={styles.userTransferEntryTitle}>
              {t('transfer.recordsTitle')}
            </Text>
            <Text style={styles.userTransferEntrySubtitle}>
              {t('transfer.recordsSubtitle')}
            </Text>
          </View>
          <ChevronRight color={colors.gold} size={18} strokeWidth={2.2} />
        </Pressable>
      ) : null}

      {!isLoggedIn ? (
        <AuthRequiredCard
          onLoginPress={() => navigation.navigate('Auth', { screen: 'Login' })}
        />
      ) : loading ? (
        <StateCard
          title={t('transfer.loadingBalances')}
          description={t('assetAction.loading')}
        />
      ) : error && balances.length === 0 ? (
        <StateCard
          title={t('assetAction.loadFailed')}
          description={error}
          actionTitle={t('assetAction.retry')}
          onActionPress={loadBalances}
        />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label={t('transfer.fromAccount')}
              value={from}
              options={accounts.map(account => ({
                value: account,
                label: accountLabel(account, t),
                disabled: account === to,
              }))}
              onChange={changeFrom}
            />
            <View style={styles.swapWrap}>
              <Pressable
                accessibilityLabel={t('transfer.swapA11y')}
                accessibilityRole="button"
                accessibilityState={{ disabled: !isSupportedRoute(to, from) }}
                android_ripple={{ color: 'rgba(212, 175, 55, 0.14)' }}
                disabled={!isSupportedRoute(to, from)}
                style={({ pressed }) => [
                  styles.swapButton,
                  pressed ? styles.pressed : null,
                ]}
                onPress={swap}
              >
                <ArrowDownUp color={colors.gold} size={18} strokeWidth={2.2} />
              </Pressable>
            </View>
            <SelectChips
              label={t('transfer.toAccount')}
              value={to}
              options={toOptions}
              onChange={changeTo}
            />
            {!routeSupported ? (
              <InlineNotice tone="red">
                {t('transfer.routeUnavailable')}
              </InlineNotice>
            ) : null}
            {contractRoute ? (
              <InlineNotice>{t('transfer.contractUsdtNotice')}</InlineNotice>
            ) : null}
            <SelectChips
              label={t('assetAction.coin')}
              value={selectedCoin}
              options={coinOptions}
              emptyText={t('transfer.noBalance')}
              onChange={value => {
                setCoin(value);
                setAmount('');
                setError('');
                setMessage('');
              }}
            />
            <ActionTextField
              label={t('assetAction.amount')}
              maxLength={85}
              value={amount}
              keyboardType="decimal-pad"
              onChangeText={value => {
                setAmount(value.replace(/[^0-9.]/g, ''));
                setError('');
                setMessage('');
              }}
              placeholder={t('transfer.amountPlaceholder')}
            />
            <View style={styles.percentRow}>
              {percents.map(percent => (
                <Pressable
                  key={percent}
                  accessibilityLabel={
                    percent === 100 ? t('assetAction.all') : `${percent}%`
                  }
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled: !isPositiveDecimalText(availableBalance.text),
                  }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                  disabled={!isPositiveDecimalText(availableBalance.text)}
                  style={({ pressed }) => [
                    styles.percentButton,
                    pressed ? styles.pressed : null,
                  ]}
                  onPress={() => setPercent(percent)}
                >
                  <Text style={styles.percentText}>
                    {percent === 100 ? 'MAX' : `${percent}%`}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.infoBlock}>
              <InfoRow
                label={t('transfer.currentAvailable')}
                value={`${formatAmount(availableBalance.text)} ${
                  selectedCoin || '--'
                }`}
              />
              <InfoRow
                label={t('transfer.direction')}
                value={`${accountLabel(from, t)} → ${accountLabel(to, t)}`}
              />
            </View>
            {amountExceedsAvailable ? (
              <InlineNotice tone="red">
                {t('transfer.insufficient')}
              </InlineNotice>
            ) : null}
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            {message ? (
              <InlineNotice tone="green">{message}</InlineNotice>
            ) : null}
            <View style={styles.buttonWrap}>
              <PrimaryButton
                title={
                  submitting
                    ? t('transfer.transferring')
                    : t('transfer.confirm')
                }
                disabled={submitDisabled}
                onPress={submit}
              />
            </View>
          </ActionCard>
        </>
      )}
    </AppScreen>
  );
}

function isSupportedRoute(
  from: AssetTransferAccountKey,
  to: AssetTransferAccountKey,
) {
  return (
    (from === 'funding' && to === 'spot') ||
    (from === 'spot' && to === 'funding') ||
    (from === 'funding' && to === 'contract') ||
    (from === 'contract' && to === 'funding')
  );
}

function isContractRoute(
  from: AssetTransferAccountKey,
  to: AssetTransferAccountKey,
) {
  return (
    (from === 'funding' && to === 'contract') ||
    (from === 'contract' && to === 'funding')
  );
}

function accountLabel(account: AssetTransferAccountKey, t: Translator) {
  if (account === 'funding') return t('assetAction.account.funding');
  if (account === 'spot') return t('assetAction.account.spot');
  return t('assetAction.account.contract');
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  userTransferEntry: {
    minHeight: 62,
    marginTop: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  userTransferEntryText: { flex: 1, paddingRight: 12 },
  userTransferEntryTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  userTransferEntrySubtitle: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 11,
  },
  swapWrap: {
    alignItems: 'center',
    marginTop: 8,
  },
  swapButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  percentRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  percentButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
  },
  percentText: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 12,
  },
  infoBlock: {
    marginTop: 12,
  },
  buttonWrap: {
    marginTop: 14,
  },
});
