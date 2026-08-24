import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
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
import type { RootStackParamList } from '../../navigation/types';
import {
  fetchDepositAddress,
  fetchDepositOptions,
  type AssetChainOption,
  type DepositAddress,
} from '../../api/assets';
import { useAuth } from '../../store/authStore';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export default function DepositScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { isLoggedIn } = useAuth();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const mountedRef = useRef(true);
  const optionsControllerRef = useRef<AbortController | null>(null);
  const optionsGenerationRef = useRef(0);
  const optionsLoadLockRef = useRef(false);
  const addressControllerRef = useRef<AbortController | null>(null);
  const addressGenerationRef = useRef(0);
  const addressLoadLockRef = useRef(false);
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
    if (!isLoggedIn || optionsLoadLockRef.current) return;
    optionsLoadLockRef.current = true;
    const generation = ++optionsGenerationRef.current;
    const controller = new AbortController();
    optionsControllerRef.current?.abort();
    optionsControllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchDepositOptions({ signal: controller.signal });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== optionsGenerationRef.current
      ) {
        return;
      }
      const enabledItems = result.items.filter(isDepositOptionEnabled);
      setOptions(enabledItems);
      setDefaultSymbol(result.defaultAssetSymbol ?? null);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== optionsGenerationRef.current
      ) {
        return;
      }
      setOptions([]);
      setError(
        toChineseError(
          requestError,
          tRef.current('deposit.loadFailed'),
          tRef.current,
        ),
      );
    } finally {
      if (generation === optionsGenerationRef.current) {
        optionsLoadLockRef.current = false;
        if (optionsControllerRef.current === controller) {
          optionsControllerRef.current = null;
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
      setOptions([]);
      setAddress(null);
      setError('');
      return undefined;
    }
    loadOptions().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      optionsGenerationRef.current += 1;
      addressGenerationRef.current += 1;
      optionsLoadLockRef.current = false;
      addressLoadLockRef.current = false;
      optionsControllerRef.current?.abort();
      addressControllerRef.current?.abort();
      optionsControllerRef.current = null;
      addressControllerRef.current = null;
    };
  }, [isLoggedIn, loadOptions]);

  const coinOptions = useMemo(() => {
    const map = new Map<string, { label: string; sort: number }>();
    options.forEach(item => {
      if (!item.coinSymbol || map.has(item.coinSymbol)) return;
      map.set(item.coinSymbol, {
        label: item.coinName
          ? `${item.coinSymbol} ${item.coinName}`
          : item.coinSymbol,
        sort: item.depositSortOrder ?? 100,
      });
    });
    return Array.from(map.entries())
      .sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]))
      .map(([value, meta]) => ({ value, label: meta.label }));
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
            (a.chainName || a.chainKey).localeCompare(
              b.chainName || b.chainKey,
            ),
        ),
    [options, selectedCoin],
  );

  const selectedNetwork = useMemo(() => {
    if (networkOptions.some(item => item.chainKey === network)) return network;
    return networkOptions[0]?.chainKey ?? '';
  }, [network, networkOptions]);

  const selectedOption = useMemo(
    () =>
      networkOptions.find(item => item.chainKey === selectedNetwork) ?? null,
    [networkOptions, selectedNetwork],
  );

  const handleCoinChange = useCallback((nextCoin: string) => {
    addressGenerationRef.current += 1;
    addressLoadLockRef.current = false;
    addressControllerRef.current?.abort();
    addressControllerRef.current = null;
    setCoin(nextCoin);
    setNetwork('');
    setAddress(null);
    setCopied('');
    setError('');
  }, []);

  const handleNetworkChange = useCallback((nextNetwork: string) => {
    addressGenerationRef.current += 1;
    addressLoadLockRef.current = false;
    addressControllerRef.current?.abort();
    addressControllerRef.current = null;
    setNetwork(nextNetwork);
    setAddress(null);
    setCopied('');
    setError('');
  }, []);

  const loadAddress = useCallback(async () => {
    if (!selectedCoin || !selectedNetwork) {
      setError(tRef.current('deposit.selectCoinNetwork'));
      return;
    }
    if (addressLoadLockRef.current) return;
    addressLoadLockRef.current = true;
    const generation = ++addressGenerationRef.current;
    const controller = new AbortController();
    addressControllerRef.current?.abort();
    addressControllerRef.current = controller;
    setAddressLoading(true);
    setError('');
    setCopied('');
    try {
      const result = await fetchDepositAddress(
        {
          symbol: selectedCoin,
          network: selectedNetwork,
        },
        { signal: controller.signal },
      );
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== addressGenerationRef.current
      ) {
        return;
      }
      setAddress(result);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== addressGenerationRef.current
      ) {
        return;
      }
      setAddress(null);
      setError(
        toChineseError(
          requestError,
          tRef.current('deposit.addressFailed'),
          tRef.current,
        ),
      );
    } finally {
      if (generation === addressGenerationRef.current) {
        addressLoadLockRef.current = false;
        if (addressControllerRef.current === controller) {
          addressControllerRef.current = null;
        }
        if (mountedRef.current && !controller.signal.aborted) {
          setAddressLoading(false);
        }
      }
    }
  }, [selectedCoin, selectedNetwork]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('deposit.title')}
        subtitle={t('deposit.subtitle')}
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={loadOptions} />}
      />

      {!isLoggedIn ? (
        <AuthRequiredCard
          onLoginPress={() => navigation.navigate('Auth', { screen: 'Login' })}
        />
      ) : loading ? (
        <StateCard
          title={t('deposit.loadingNetworks')}
          description={t('assetAction.loading')}
        />
      ) : error && options.length === 0 ? (
        <StateCard
          title={t('assetAction.loadFailed')}
          description={error}
          actionTitle={t('assetAction.retry')}
          onActionPress={loadOptions}
        />
      ) : coinOptions.length === 0 ? (
        <StateCard
          title={t('deposit.noNetworks')}
          description={t('deposit.noNetworksDescription')}
        />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label={t('assetAction.coin')}
              value={selectedCoin}
              options={coinOptions}
              onChange={handleCoinChange}
              searchable
            />
            <SelectChips
              label={t('assetAction.network')}
              value={selectedNetwork}
              options={networkOptions.map(item => ({
                value: item.chainKey,
                label: item.chainName || item.chainKey.toUpperCase(),
                meta: item.chainId ? String(item.chainId) : undefined,
              }))}
              emptyText={t('deposit.noCoinNetworks')}
              onChange={handleNetworkChange}
              searchable
            />
            {selectedOption ? (
              <View style={styles.metaBox}>
                <InfoRow
                  label={t('deposit.minAmount')}
                  value={
                    selectedOption.minDeposit
                      ? `${formatAmount(
                          selectedOption.minDeposit,
                        )} ${selectedCoin}`
                      : '--'
                  }
                />
                <InfoRow
                  label={t('deposit.confirmations')}
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
                title={
                  addressLoading
                    ? t('deposit.gettingAddress')
                    : t('deposit.getAddress')
                }
                disabled={addressLoading || !selectedCoin || !selectedNetwork}
                onPress={loadAddress}
              />
            </View>
          </ActionCard>

          {address ? (
            <ActionCard>
              <Text style={styles.cardTitle}>{t('deposit.addressTitle')}</Text>
              <View
                accessible
                accessibilityLabel={t('deposit.qrA11y', {
                  symbol: address.symbol,
                  network: address.network,
                })}
                style={styles.qrWrap}
              >
                <QRCode
                  backgroundColor="#FFFFFF"
                  color="#111111"
                  quietZone={8}
                  size={168}
                  value={address.address}
                />
              </View>
              <Text style={styles.qrHint}>{t('deposit.scanQr')}</Text>
              <View style={styles.addressRow}>
                <View style={styles.addressTextWrap}>
                  <Text style={styles.addressText}>
                    {maskMiddle(address.address, 10, 10)}
                  </Text>
                  <Text style={styles.addressHint}>
                    {t('deposit.copyFullAddress')}
                  </Text>
                </View>
                <CopyIconButton
                  text={address.address}
                  onCopied={() => setCopied('address')}
                />
              </View>
              {copied === 'address' ? (
                <Text style={styles.copyHint}>
                  {t('deposit.addressCopied')}
                </Text>
              ) : null}
              {address.memo ? (
                <View style={styles.memoBox}>
                  <InfoRow label="Memo/Tag" value={address.memo} mono />
                  <CopyIconButton
                    text={address.memo}
                    onCopied={() => setCopied('memo')}
                  />
                  {copied === 'memo' ? (
                    <Text style={styles.copyHint}>
                      {t('deposit.memoCopied')}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              <InfoRow label={t('assetAction.coin')} value={address.symbol} />
              <InfoRow
                label={t('assetAction.network')}
                value={address.network}
              />
              <InfoRow
                label={t('deposit.minAmount')}
                value={
                  address.minDeposit
                    ? `${formatAmount(address.minDeposit)} ${address.symbol}`
                    : '--'
                }
              />
              <InfoRow
                label={t('deposit.confirmations')}
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
            <InlineNotice>{t('deposit.guidance')}</InlineNotice>
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
  qrWrap: {
    width: 184,
    height: 184,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  qrHint: {
    marginTop: 8,
    marginBottom: 12,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
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
