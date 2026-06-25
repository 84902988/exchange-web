import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {ArrowDownUp} from 'lucide-react-native';
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
import type {RootStackParamList} from '../../navigation/types';
import {
  fetchAssetAccountBalances,
  submitContractTransfer,
  submitFundingSpotTransfer,
  type AssetAccountBalance,
  type AssetTransferAccountKey,
} from '../../api/assets';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

const accounts: AssetTransferAccountKey[] = ['funding', 'spot', 'contract'];
const percents = [25, 50, 75, 100];

export default function TransferScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [balances, setBalances] = useState<AssetAccountBalance[]>([]);
  const [from, setFrom] = useState<AssetTransferAccountKey>('funding');
  const [to, setTo] = useState<AssetTransferAccountKey>('spot');
  const [coin, setCoin] = useState('USDT');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadBalances = useCallback(async () => {
    if (!isLoggedIn) return;
    setLoading(true);
    setError('');
    try {
      setBalances(await fetchAssetAccountBalances());
    } catch (requestError) {
      setBalances([]);
      setError(toChineseError(requestError, '账户余额加载失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) {
      setBalances([]);
      setError('');
      return;
    }
    loadBalances().catch(() => undefined);
  }, [isLoggedIn, loadBalances]);

  const routeSupported = isSupportedRoute(from, to);
  const contractRoute = isContractRoute(from, to);

  const toOptions = useMemo(
    () =>
      accounts.map(account => ({
        value: account,
        label: accountLabel(account),
        disabled: account === from || !isSupportedRoute(from, account),
      })),
    [from],
  );

  const coinOptions = useMemo(() => {
    if (!routeSupported) return [];
    if (contractRoute) return [{value: 'USDT', label: 'USDT'}];
    const rows = balances
      .filter(item => item.accountKey.toLowerCase() === from)
      .filter(item => (item.available ?? 0) > 0)
      .map(item => item.symbol.toUpperCase());
    return Array.from(new Set(rows))
      .sort((a, b) => {
        if (a === 'USDT') return -1;
        if (b === 'USDT') return 1;
        return a.localeCompare(b);
      })
      .map(symbol => ({value: symbol, label: symbol}));
  }, [balances, contractRoute, from, routeSupported]);

  const selectedCoin = useMemo(() => {
    if (contractRoute) return 'USDT';
    if (coinOptions.some(item => item.value === coin)) return coin;
    return coinOptions[0]?.value ?? '';
  }, [coin, coinOptions, contractRoute]);

  const available = useMemo(() => {
    const row = balances.find(
      item =>
        item.accountKey.toLowerCase() === from &&
        item.symbol.toUpperCase() === selectedCoin,
    );
    return row?.available ?? 0;
  }, [balances, from, selectedCoin]);

  const amountNumber = Number(amount);
  const amountValid = Number.isFinite(amountNumber) && amountNumber > 0;
  const submitDisabled =
    submitting ||
    !routeSupported ||
    !selectedCoin ||
    !amountValid ||
    amountNumber > available;

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
        : accounts.find(account => isSupportedRoute(normalized, account)) ?? 'spot';
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
      if (available <= 0) {
        setAmount('');
        return;
      }
      setAmount(String((available * percent) / 100));
      setError('');
      setMessage('');
    },
    [available],
  );

  const submit = useCallback(async () => {
    setError('');
    setMessage('');
    if (!routeSupported) {
      setError('当前账户方向暂不支持划转');
      return;
    }
    if (!selectedCoin) {
      setError('当前转出账户暂无可划转币种');
      return;
    }
    if (contractRoute && selectedCoin !== 'USDT') {
      setError('合约账户划转 V1 仅支持 USDT');
      return;
    }
    if (!amountValid) {
      setError('请输入正确的划转数量');
      return;
    }
    if (amountNumber > available) {
      setError('可划转余额不足');
      return;
    }

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
        await submitContractTransfer({direction: 'in', amount});
      } else if (from === 'contract' && to === 'funding') {
        await submitContractTransfer({direction: 'out', amount});
      } else {
        setError('当前账户方向暂不支持划转');
        return;
      }
      setMessage('划转成功，余额已刷新。');
      setAmount('');
      await loadBalances();
    } catch (requestError) {
      setError(toChineseError(requestError, '划转失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }, [
    amount,
    amountNumber,
    amountValid,
    available,
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
        title="划转"
        subtitle="资金账户、现货账户与合约账户之间划转"
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={loadBalances} />}
      />

      {!isLoggedIn ? (
        <AuthRequiredCard onLoginPress={() => navigation.navigate('Auth', {screen: 'Login'})} />
      ) : loading ? (
        <StateCard title="正在加载账户余额" description="请稍候" />
      ) : error && balances.length === 0 ? (
        <StateCard title="加载失败" description={error} actionTitle="重试" onActionPress={loadBalances} />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label="转出账户"
              value={from}
              options={accounts.map(account => ({
                value: account,
                label: accountLabel(account),
                disabled: account === to,
              }))}
              onChange={changeFrom}
            />
            <View style={styles.swapWrap}>
              <Pressable
                disabled={!isSupportedRoute(to, from)}
                style={styles.swapButton}
                onPress={swap}>
                <ArrowDownUp color={colors.gold} size={18} strokeWidth={2.2} />
              </Pressable>
            </View>
            <SelectChips
              label="转入账户"
              value={to}
              options={toOptions}
              onChange={changeTo}
            />
            {!routeSupported ? (
              <InlineNotice tone="red">当前后端不支持该账户方向，已禁止提交。</InlineNotice>
            ) : null}
            {contractRoute ? (
              <InlineNotice>合约账户划转 V1 仅支持 USDT。</InlineNotice>
            ) : null}
            <SelectChips
              label="币种"
              value={selectedCoin}
              options={coinOptions}
              emptyText="当前转出账户暂无可划转余额"
              onChange={value => {
                setCoin(value);
                setAmount('');
                setError('');
                setMessage('');
              }}
            />
            <ActionTextField
              label="数量"
              value={amount}
              keyboardType="decimal-pad"
              onChangeText={value => {
                setAmount(value.replace(/[^0-9.]/g, ''));
                setError('');
                setMessage('');
              }}
              placeholder="请输入划转数量"
            />
            <View style={styles.percentRow}>
              {percents.map(percent => (
                <Pressable
                  key={percent}
                  disabled={available <= 0}
                  style={styles.percentButton}
                  onPress={() => setPercent(percent)}>
                  <Text style={styles.percentText}>
                    {percent === 100 ? 'MAX' : `${percent}%`}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.infoBlock}>
              <InfoRow label="当前可划转" value={`${formatAmount(available)} ${selectedCoin || '--'}`} />
              <InfoRow label="方向" value={`${accountLabel(from)} -> ${accountLabel(to)}`} />
            </View>
            {amountNumber > available ? <InlineNotice tone="red">可划转余额不足</InlineNotice> : null}
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            {message ? <InlineNotice tone="green">{message}</InlineNotice> : null}
            <View style={styles.buttonWrap}>
              <PrimaryButton
                title={submitting ? '划转中...' : '确认划转'}
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

function isSupportedRoute(from: AssetTransferAccountKey, to: AssetTransferAccountKey) {
  return (
    (from === 'funding' && to === 'spot') ||
    (from === 'spot' && to === 'funding') ||
    (from === 'funding' && to === 'contract') ||
    (from === 'contract' && to === 'funding')
  );
}

function isContractRoute(from: AssetTransferAccountKey, to: AssetTransferAccountKey) {
  return (
    (from === 'funding' && to === 'contract') ||
    (from === 'contract' && to === 'funding')
  );
}

function accountLabel(account: AssetTransferAccountKey) {
  if (account === 'funding') return '资金账户';
  if (account === 'spot') return '现货账户';
  return '合约账户';
}

const styles = StyleSheet.create({
  swapWrap: {
    alignItems: 'center',
    marginTop: 8,
  },
  swapButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
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
    minHeight: 34,
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
