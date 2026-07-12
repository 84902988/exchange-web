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
  CopyIconButton,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SelectChips,
  StateCard,
  formatAmount,
  maskMiddle,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type {RootStackParamList} from '../../navigation/types';
import {
  fetchDepositAddress,
  fetchDepositOptions,
  type AssetChainOption,
  type DepositAddress,
} from '../../api/assets';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export default function DepositScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [options, setOptions] = useState<AssetChainOption[]>([]);
  const [defaultSymbol, setDefaultSymbol] = useState<string | null>(null);
  const [coin, setCoin] = useState('');
  const [network, setNetwork] = useState('');
  const [address, setAddress] = useState<DepositAddress | null>(null);
  const [loading, setLoading] = useState(false);
  const [addressLoading, setAddressLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const loadOptions = useCallback(async () => {
    if (!isLoggedIn) return;
    setLoading(true);
    setError('');
    try {
      const result = await fetchDepositOptions();
      const enabledItems = result.items.filter(isDepositOptionEnabled);
      setOptions(enabledItems);
      setDefaultSymbol(result.defaultAssetSymbol ?? null);
    } catch (requestError) {
      setOptions([]);
      setError(toChineseError(requestError, '充值网络加载失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) {
      setOptions([]);
      setAddress(null);
      setError('');
      return;
    }
    loadOptions().catch(() => undefined);
  }, [isLoggedIn, loadOptions]);

  const coinOptions = useMemo(() => {
    const map = new Map<string, {label: string; sort: number}>();
    options.forEach(item => {
      if (!item.coinSymbol || map.has(item.coinSymbol)) return;
      map.set(item.coinSymbol, {
        label: item.coinName ? `${item.coinSymbol} ${item.coinName}` : item.coinSymbol,
        sort: item.depositSortOrder ?? 100,
      });
    });
    return Array.from(map.entries())
      .sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]))
      .map(([value, meta]) => ({value, label: meta.label}));
  }, [options]);

  const selectedCoin = useMemo(() => {
    if (coinOptions.some(item => item.value === coin)) return coin;
    const preferred = defaultSymbol
      ? coinOptions.find(item => item.value === defaultSymbol)?.value
      : undefined;
    return preferred ?? coinOptions[0]?.value ?? '';
  }, [coin, coinOptions, defaultSymbol]);

  const networkOptions = useMemo(
    () =>
      options
        .filter(item => item.coinSymbol === selectedCoin)
        .sort(
          (a, b) =>
            (a.depositSortOrder ?? 100) - (b.depositSortOrder ?? 100) ||
            (a.chainName || a.chainKey).localeCompare(b.chainName || b.chainKey),
        ),
    [options, selectedCoin],
  );

  const selectedNetwork = useMemo(() => {
    if (networkOptions.some(item => item.chainKey === network)) return network;
    return networkOptions[0]?.chainKey ?? '';
  }, [network, networkOptions]);

  const selectedOption = useMemo(
    () => networkOptions.find(item => item.chainKey === selectedNetwork) ?? null,
    [networkOptions, selectedNetwork],
  );

  const handleCoinChange = useCallback((nextCoin: string) => {
    setCoin(nextCoin);
    setNetwork('');
    setAddress(null);
    setCopied('');
    setError('');
  }, []);

  const handleNetworkChange = useCallback((nextNetwork: string) => {
    setNetwork(nextNetwork);
    setAddress(null);
    setCopied('');
    setError('');
  }, []);

  const loadAddress = useCallback(async () => {
    if (!selectedCoin || !selectedNetwork) {
      setError('请先选择币种和网络');
      return;
    }
    setAddressLoading(true);
    setError('');
    setCopied('');
    try {
      const result = await fetchDepositAddress({
        symbol: selectedCoin,
        network: selectedNetwork,
      });
      setAddress(result);
    } catch (requestError) {
      setAddress(null);
      setError(toChineseError(requestError, '充值地址获取失败，请稍后重试'));
    } finally {
      setAddressLoading(false);
    }
  }, [selectedCoin, selectedNetwork]);

  return (
    <AppScreen>
      <ActionHeader
        title="充值"
        subtitle="按币种和网络获取专属充值地址"
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={loadOptions} />}
      />

      {!isLoggedIn ? (
        <AuthRequiredCard onLoginPress={() => navigation.navigate('Auth', {screen: 'Login'})} />
      ) : loading ? (
        <StateCard title="正在加载充值网络" description="请稍候" />
      ) : error && options.length === 0 ? (
        <StateCard title="加载失败" description={error} actionTitle="重试" onActionPress={loadOptions} />
      ) : coinOptions.length === 0 ? (
        <StateCard title="暂无可用充值网络" description="后台当前没有开启可充值的币种或网络。" />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label="币种"
              value={selectedCoin}
              options={coinOptions}
              onChange={handleCoinChange}
            />
            <SelectChips
              label="网络"
              value={selectedNetwork}
              options={networkOptions.map(item => ({
                value: item.chainKey,
                label: item.chainName || item.chainKey.toUpperCase(),
                meta: item.chainId ? String(item.chainId) : undefined,
              }))}
              emptyText="该币种暂无可用充值网络"
              onChange={handleNetworkChange}
            />
            {selectedOption ? (
              <View style={styles.metaBox}>
                <InfoRow
                  label="最小充值"
                  value={
                    selectedOption.minDeposit
                      ? `${selectedOption.minDeposit} ${selectedCoin}`
                      : '--'
                  }
                />
                <InfoRow
                  label="确认数"
                  value={
                    selectedOption.confirmations !== null &&
                    selectedOption.confirmations !== undefined
                      ? String(selectedOption.confirmations)
                      : '--'
                  }
                />
              </View>
            ) : null}
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            <View style={styles.buttonWrap}>
              <PrimaryButton
                title={addressLoading ? '获取中...' : '获取充值地址'}
                disabled={addressLoading || !selectedCoin || !selectedNetwork}
                onPress={loadAddress}
              />
            </View>
          </ActionCard>

          {address ? (
            <ActionCard>
              <Text style={styles.cardTitle}>充值地址</Text>
              <View style={styles.addressRow}>
                <View style={styles.addressTextWrap}>
                  <Text style={styles.addressText}>{maskMiddle(address.address, 10, 10)}</Text>
                  <Text style={styles.addressHint}>复制时会复制完整地址</Text>
                </View>
                <CopyIconButton
                  text={address.address}
                  onCopied={() => setCopied('address')}
                />
              </View>
              {copied === 'address' ? (
                <Text style={styles.copyHint}>地址已复制</Text>
              ) : null}
              {address.memo ? (
                <View style={styles.memoBox}>
                  <InfoRow label="Memo/Tag" value={address.memo} mono />
                  <CopyIconButton text={address.memo} onCopied={() => setCopied('memo')} />
                  {copied === 'memo' ? <Text style={styles.copyHint}>Memo 已复制</Text> : null}
                </View>
              ) : null}
              <InfoRow label="币种" value={address.symbol} />
              <InfoRow label="网络" value={address.network} />
              <InfoRow
                label="最小充值"
                value={
                  address.minDeposit
                    ? `${formatAmount(address.minDeposit)} ${address.symbol}`
                    : '--'
                }
              />
              <InfoRow
                label="确认数"
                value={
                  address.confirmRequired !== null &&
                  address.confirmRequired !== undefined
                    ? String(address.confirmRequired)
                    : '--'
                }
              />
              {address.notice.length > 0 ? (
                <InlineNotice>
                  {address.notice.map(item => `• ${item}`).join('\n')}
                </InlineNotice>
              ) : null}
            </ActionCard>
          ) : (
            <InlineNotice>请选择币种和网络后点击获取地址，不会自动批量生成地址。</InlineNotice>
          )}
        </>
      )}
    </AppScreen>
  );
}

function isDepositOptionEnabled(item: AssetChainOption) {
  return (
    item.enabled !== false &&
    item.assetEnabled !== false &&
    item.chainEnabled !== false &&
    item.assetChainEnabled !== false &&
    item.depositEnabled !== false
  );
}

const styles = StyleSheet.create({
  metaBox: {
    marginTop: 10,
  },
  buttonWrap: {
    marginTop: 14,
  },
  cardTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
    marginBottom: 10,
  },
  addressRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    padding: 10,
  },
  addressTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  addressText: {
    ...typography.identifier,
    color: colors.text,
    fontSize: 14,
  },
  addressHint: {
    marginTop: 4,
    color: colors.textSubtle,
    fontSize: 10,
  },
  copyHint: {
    marginTop: 8,
    color: colors.green,
    fontSize: 12,
  },
  memoBox: {
    marginTop: 10,
    gap: 8,
  },
});
