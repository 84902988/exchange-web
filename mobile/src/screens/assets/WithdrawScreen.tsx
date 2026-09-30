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
  SmallTextButton,
  StateCard,
  formatAmount,
  maskMiddle,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import {
  confirmWithdraw,
  sendWithdrawTx,
  type WithdrawRecord,
  createWithdrawDraft,
  fetchAssetAccountBalances,
  fetchWithdrawFee,
  fetchWithdrawOptions,
  fetchWithdrawRecords,
  sendWithdrawCode,
  type AssetAccountBalance,
  type AssetChainOption,
  type WithdrawCreateResponse,
  type WithdrawFeeEstimate,
} from '../../api/assets';
import { useAuth } from '../../store/authStore';
import { useLanguage } from '../../i18n';
import WithdrawRecords from '../../components/assets/action/WithdrawRecords';
import {mapWithdrawStatus} from '../../utils/withdrawStatus';
import {confirmationRecordStatus, findWithdrawalConfirmation} from '../../utils/withdrawConfirmation';
import { colors, typography } from '../../theme';
import {
  compareNonNegativeDecimalText,
  isPositiveDecimalText,
} from '../../utils/decimalText';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
type Step = 'form' | 'verify' | 'done';

export default function WithdrawScreen() {
  const {isLoggedIn, user} = useAuth();
  return <WithdrawScreenContent key={isLoggedIn ? user?.id ?? 'signed-in' : 'guest'} />;
}

function WithdrawScreenContent() {
  const navigation = useNavigation<RootNavigation>();
  const { isLoggedIn } = useAuth();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [options, setOptions] = useState<AssetChainOption[]>([]);
  const [balances, setBalances] = useState<AssetAccountBalance[]>([]);
  const [defaultSymbol, setDefaultSymbol] = useState<string | null>(null);
  const [coin, setCoin] = useState('');
  const [network, setNetwork] = useState('');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState<WithdrawCreateResponse | null>(null);
  const [fee, setFee] = useState<WithdrawFeeEstimate | null>(null);
  const [feeFingerprint, setFeeFingerprint] = useState<string | null>(null);
  const [feeError, setFeeError] = useState('');
  const [feeRequestNonce, setFeeRequestNonce] = useState(0);
  const [showRecords, setShowRecords] = useState(false);
  const [recordsRevision, setRecordsRevision] = useState(0);
  const [sendError, setSendError] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(false);
  const [feeLoading, setFeeLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmationUncertain, setConfirmationUncertain] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mountedRef = useRef(true);
  const dataControllerRef = useRef<AbortController | null>(null);
  const dataGenerationRef = useRef(0);
  const dataLoadLockRef = useRef(false);
  const draftSubmitLockRef = useRef(false);
  const codeSendLockRef = useRef(false);
  const confirmLockRef = useRef(false);
  const recoveryLockRef = useRef(false);
  const confirmationUncertainRef = useRef(false);
  const flowGenerationRef = useRef(0);
  const draftIdRef = useRef(draft?.withdrawId);
  draftIdRef.current = draft?.withdrawId;

  const setUncertain = useCallback((value: boolean) => {
    confirmationUncertainRef.current = value;
    setConfirmationUncertain(value);
  }, []);

  useEffect(() => () => { flowGenerationRef.current += 1; }, []);

  const loadData = useCallback(async () => {
    if (!isLoggedIn || !mountedRef.current || dataLoadLockRef.current) return;
    dataLoadLockRef.current = true;
    const generation = ++dataGenerationRef.current;
    const controller = new AbortController();
    dataControllerRef.current?.abort();
    dataControllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const [optionResult, balanceRows] = await Promise.all([
        fetchWithdrawOptions({ signal: controller.signal }),
        fetchAssetAccountBalances({ signal: controller.signal }),
      ]);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== dataGenerationRef.current
      ) {
        return;
      }
      setOptions(optionResult.items.filter(isWithdrawOptionEnabled));
      setDefaultSymbol(optionResult.defaultAssetSymbol ?? null);
      setBalances(balanceRows);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== dataGenerationRef.current
      ) {
        return;
      }
      setOptions([]);
      setBalances([]);
      setError(
        toChineseError(
          requestError,
          tRef.current('withdraw.loadFailed'),
          tRef.current,
        ),
      );
    } finally {
      if (generation === dataGenerationRef.current) {
        dataLoadLockRef.current = false;
        if (dataControllerRef.current === controller) {
          dataControllerRef.current = null;
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
      setBalances([]);
      setError('');
      return undefined;
    }
    loadData().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      dataGenerationRef.current += 1;
      dataLoadLockRef.current = false;
      dataControllerRef.current?.abort();
      dataControllerRef.current = null;
    };
  }, [isLoggedIn, loadData]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown(current => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const coinOptions = useMemo(() => {
    const map = new Map<string, { label: string; sort: number }>();
    options.forEach(item => {
      if (!item.coinSymbol || map.has(item.coinSymbol)) return;
      map.set(item.coinSymbol, {
        label: item.coinName
          ? `${item.coinSymbol} ${item.coinName}`
          : item.coinSymbol,
        sort: item.withdrawSortOrder ?? 100,
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
            (a.withdrawSortOrder ?? 100) - (b.withdrawSortOrder ?? 100) ||
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

  const fundingBalance = useMemo(() => {
    const row = balances.find(
      item =>
        item.accountKey.toLowerCase() === 'funding' &&
        item.symbol.toUpperCase() === selectedCoin,
    );
    const available = row?.available ?? 0;
    return {
      text:
        row?.availableText ??
        (Number.isFinite(available) ? String(available) : '0'),
    };
  }, [balances, selectedCoin]);

  const amountValid = isPositiveDecimalText(amount);
  const amountExceedsBalance =
    compareNonNegativeDecimalText(amount, fundingBalance.text) === 1;
  const currentFeeFingerprint = buildWithdrawFeeFingerprint({
    address,
    amount,
    network: selectedNetwork,
    symbol: selectedCoin,
  });
  const feeReady = isWithdrawFeeReady(
    fee,
    feeFingerprint,
    currentFeeFingerprint,
  );
  const submitDisabled =
    submitting ||
    feeLoading ||
    !feeReady ||
    Boolean(feeError) ||
    !selectedCoin ||
    !selectedNetwork ||
    !address.trim() ||
    !amountValid ||
    amountExceedsBalance;

  useEffect(() => {
    setFee(null);
    setFeeFingerprint(null);
    setFeeError('');
    setFeeLoading(false);
    if (!isLoggedIn || !selectedCoin || !selectedNetwork || !amountValid)
      return;
    let alive = true;
    const controller = new AbortController();
    setFeeLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await fetchWithdrawFee(
          {
            symbol: selectedCoin,
            network: selectedNetwork,
            amount,
            toAddress: address.trim() || undefined,
          },
          { signal: controller.signal },
        );
        if (alive) {
          setFee(result);
          setFeeFingerprint(currentFeeFingerprint);
        }
      } catch (requestError) {
        if (alive) {
          setFee(null);
          setFeeError(
            toChineseError(
              requestError,
              tRef.current('withdraw.feeFailed'),
              tRef.current,
            ),
          );
        }
      } finally {
        if (alive) setFeeLoading(false);
      }
    }, 450);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    address,
    amount,
    amountValid,
    feeRequestNonce,
    currentFeeFingerprint,
    isLoggedIn,
    selectedCoin,
    selectedNetwork,
  ]);

  const resetFlow = useCallback(() => {
    if (confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
    flowGenerationRef.current += 1;
    setSendError(false);
    setStep('form');
    setDraft(null);
    setCode('');
    setCooldown(0);
    setMessage('');
    setError('');
  }, []);

  const changeCoin = useCallback(
    (nextCoin: string) => {
      if (draftSubmitLockRef.current || confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
      setCoin(nextCoin);
      setNetwork('');
      setAmount('');
      setAddress('');
      resetFlow();
    },
    [resetFlow],
  );

  const changeNetwork = useCallback(
    (nextNetwork: string) => {
      if (draftSubmitLockRef.current || confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
      setNetwork(nextNetwork);
      setAddress('');
      resetFlow();
    },
    [resetFlow],
  );

  const submitDraft = useCallback(async () => {
    if (draftSubmitLockRef.current) return;
    setError('');
    setMessage('');
    if (!selectedCoin) {
      setError(tRef.current('withdraw.selectCoin'));
      return;
    }
    if (!selectedNetwork) {
      setError(tRef.current('withdraw.selectNetwork'));
      return;
    }
    if (!address.trim()) {
      setError(tRef.current('withdraw.enterAddress'));
      return;
    }
    if (!amountValid) {
      setError(tRef.current('withdraw.invalidAmount'));
      return;
    }
    if (amountExceedsBalance) {
      setError(tRef.current('withdraw.insufficientFunding'));
      return;
    }
    if (
      selectedOption?.minWithdraw &&
      compareNonNegativeDecimalText(amount, selectedOption.minWithdraw) === -1
    ) {
      setError(
        tRef.current('withdraw.minimumAmount', {
          amount: formatAmount(selectedOption.minWithdraw),
          symbol: selectedCoin,
        }),
      );
      return;
    }
    if (!feeReady || feeError) {
      setError(tRef.current('withdraw.requireFee'));
      return;
    }

    draftSubmitLockRef.current = true;
    setSubmitting(true);
    try {
      const result = await createWithdrawDraft({
        symbol: selectedCoin,
        network: selectedNetwork,
        toAddress: address,
        amount,
      });
      if (!mountedRef.current) return;
      setDraft(result);
      if (
        result.needManualReview ||
        result.status.toUpperCase() === 'REVIEWING'
      ) {
        setStep('done');
        setMessage(tRef.current('withdraw.reviewSubmitted'));
      } else {
        setStep('verify');
        setMessage(tRef.current('withdraw.verifyCreated'));
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          toChineseError(
            requestError,
            tRef.current('withdraw.submitFailed'),
            tRef.current,
          ),
        );
      }
    } finally {
      draftSubmitLockRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    address,
    amount,
    amountValid,
    amountExceedsBalance,
    feeError,
    feeReady,
    selectedCoin,
    selectedNetwork,
    selectedOption?.minWithdraw,
  ]);

  const sendCode = useCallback(async () => {
    if (codeSendLockRef.current || cooldown > 0) return;
    if (!draft?.withdrawId) {
      setError(tRef.current('withdraw.missingId'));
      return;
    }
    codeSendLockRef.current = true;
    setCodeSending(true);
    setError('');
    try {
      await sendWithdrawCode(draft.withdrawId);
      if (mountedRef.current) {
        setCooldown(60);
        setMessage(tRef.current('withdraw.codeSent'));
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          toChineseError(
            requestError,
            tRef.current('withdraw.codeFailed'),
            tRef.current,
          ),
        );
      }
    } finally {
      codeSendLockRef.current = false;
      if (mountedRef.current) setCodeSending(false);
    }
  }, [cooldown, draft?.withdrawId]);

  const applyConfirmationRecord = useCallback((row: WithdrawRecord) => {
    if (!mountedRef.current || row.withdrawId !== draftIdRef.current) return;
    const status = confirmationRecordStatus(row);
    if (!status) return;
    setUncertain(false);
    setStep(status === 'VERIFYING' ? 'verify' : 'done');
    setMessage('');
    setError('');
    setSendError(false);
    if (status !== 'VERIFYING') setCode('');
    setDraft(current => current?.withdrawId === row.withdrawId
      ? {...current, status, feeEstimate: row.fee, feeCoin: row.feeCoin} : current);
  }, [setUncertain]);

  const recoverConfirmation = useCallback(async (id: number, generation: number, verificationError = '') => {
    if (recoveryLockRef.current) return;
    const isCurrent = () => mountedRef.current && flowGenerationRef.current === generation && draftIdRef.current === id;
    if (!isCurrent()) return;
    recoveryLockRef.current = true;
    setConfirming(true);
    setUncertain(true);
    setStep('done');
    setMessage('');
    setError('');
    setDraft(current => current?.withdrawId === id ? {...current, status: 'UNKNOWN'} : current);
    try {
      const row = await findWithdrawalConfirmation(id, offset => fetchWithdrawRecords(offset), isCurrent);
      if (!isCurrent()) return;
      if (row) {
        applyConfirmationRecord(row);
        if (confirmationRecordStatus(row) === 'VERIFYING' && verificationError) setError(verificationError);
      }
    } catch {
      // An unreadable result is uncertainty, never proof of a failed confirmation.
    } finally {
      recoveryLockRef.current = false;
      if (isCurrent()) {
        setShowRecords(true);
        setRecordsRevision(value => value + 1);
        if (!confirmLockRef.current) setConfirming(false);
      }
    }
  }, [applyConfirmationRecord, setUncertain]);

  const confirm = useCallback(async () => {
    if (confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
    if (!draft?.withdrawId) {
      setError(tRef.current('withdraw.missingId'));
      return;
    }
    if (!code.trim()) {
      setError(tRef.current('withdraw.enterCode'));
      return;
    }
    confirmLockRef.current = true;
    const id = draft.withdrawId;
    const generation = flowGenerationRef.current;
    const isCurrent = () => mountedRef.current && flowGenerationRef.current === generation && draftIdRef.current === id;
    setConfirming(true);
    setError('');
    try {
      const result = await confirmWithdraw({
        withdrawId: id,
        code,
      });
      if (!isCurrent()) return;
      if (result.withdrawId !== id || result.status !== 'FROZEN') throw new Error('Unconfirmed withdrawal response');
      setUncertain(false);
      setStep('done');
      setDraft(current =>
        current?.withdrawId === id
          ? {
              ...current,
              status: result.status,
              feeEstimate: result.feeFinal,
              feeCoin: result.feeCoin,
              receiveAmount: result.receiveAmount || current.receiveAmount,
            }
          : current,
      );
      setMessage('');
      setCode('');
      setSendError(false);
      try {
        // Confirm reserves the funds; sending is a separate, authenticated step.
        const sent = await sendWithdrawTx(result.withdrawId);
        if (!isCurrent()) return;
        setDraft(current => current?.withdrawId === result.withdrawId
          ? {...current, status: sent.status} : current);
      } catch {
        if (!isCurrent()) return;
        setSendError(true);
      }
      setShowRecords(true);
      setRecordsRevision(value => value + 1);
      await loadData();
    } catch (requestError) {
      if (isCurrent()) {
        await recoverConfirmation(id, generation, toChineseError(
          requestError, tRef.current('withdraw.confirmFailed'), tRef.current,
        ));
      }
    } finally {
      confirmLockRef.current = false;
      if (isCurrent()) setConfirming(false);
    }
  }, [code, draft?.withdrawId, loadData, recoverConfirmation, setUncertain]);

  const onRecordsChange = useCallback((rows: WithdrawRecord[]) => {
    if (confirmLockRef.current || recoveryLockRef.current || !mountedRef.current) return;
    const row = rows.find(item => item.withdrawId === draft?.withdrawId);
    if (confirmationUncertainRef.current) {
      if (row) applyConfirmationRecord(row);
      return;
    }
    if (row) {
      setMessage('');
      if (row.status !== 'FROZEN') setSendError(false);
    }
    setDraft(current => {
      const matching = rows.find(item => item.withdrawId === current?.withdrawId);
      return current && matching ? {...current, status: matching.status} : current;
    });
  }, [draft?.withdrawId, applyConfirmationRecord]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('withdraw.title')}
        subtitle={t('withdraw.subtitle')}
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={loadData} />}
      />

      <ActionCard>
        <SelectChips
          label={t('withdraw.method')}
          value="onchain"
          options={[
            { value: 'onchain', label: t('withdraw.method.onchain') },
            { value: 'internal', label: t('withdraw.method.internal') },
          ]}
          onChange={value => {
            if (value === 'internal') navigation.navigate('AssetUserTransfer');
          }}
        />
      </ActionCard>

      {!isLoggedIn ? (
        <AuthRequiredCard
          onLoginPress={() => navigation.navigate('Auth', { screen: 'Login' })}
        />
      ) : loading ? (
        <StateCard
          title={t('withdraw.loadingConfig')}
          description={t('assetAction.loading')}
        />
      ) : error && options.length === 0 ? (
        <StateCard
          title={t('assetAction.loadFailed')}
          description={error}
          actionTitle={t('assetAction.retry')}
          onActionPress={loadData}
        />
      ) : coinOptions.length === 0 ? (
        <StateCard
          title={t('withdraw.noNetworks')}
          description={t('withdraw.noNetworksDescription')}
        />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label={t('assetAction.coin')}
              value={selectedCoin}
              options={coinOptions}
              onChange={changeCoin}
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
              onChange={changeNetwork}
              searchable
            />
            <ActionTextField
              label={t('withdraw.address')}
              maxLength={256}
              value={address}
              onChangeText={value => {
                if (draftSubmitLockRef.current || confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
                setAddress(value);
                resetFlow();
              }}
              placeholder={t('withdraw.addressPlaceholder')}
            />
            <ActionTextField
              label={t('assetAction.amount')}
              maxLength={85}
              value={amount}
              keyboardType="decimal-pad"
              onChangeText={value => {
                if (draftSubmitLockRef.current || confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
                setAmount(value.replace(/[^0-9.]/g, ''));
                resetFlow();
              }}
              placeholder={t('withdraw.amountPlaceholder')}
              right={
                <SmallTextButton
                  title={t('assetAction.all')}
                  disabled={submitting || confirming}
                  onPress={() => {
                    if (draftSubmitLockRef.current || confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
                    setAmount(
                      isPositiveDecimalText(fundingBalance.text)
                        ? fundingBalance.text
                        : '',
                    );
                    resetFlow();
                  }}
                />
              }
            />
            <View style={styles.infoBlock}>
              <InfoRow
                label={t('withdraw.fundingAvailable')}
                value={`${formatAmount(fundingBalance.text)} ${selectedCoin}`}
              />
              <InfoRow
                label={t('assetAction.fee')}
                value={
                  feeLoading
                    ? t('withdraw.calculating')
                    : fee
                    ? `${formatAmount(fee.fee)} ${fee.feeCoin}`
                    : '--'
                }
              />
              <InfoRow
                label={t('withdraw.minAmount')}
                value={
                  selectedOption?.minWithdraw
                    ? `${formatAmount(
                        selectedOption.minWithdraw,
                      )} ${selectedCoin}`
                    : '--'
                }
              />
              <InfoRow
                label={t('withdraw.maxAmount')}
                value={`${formatAmount(fundingBalance.text)} ${selectedCoin}`}
              />
            </View>
            {selectedOption?.riskTip ? (
              <InlineNotice>{selectedOption.riskTip}</InlineNotice>
            ) : null}
            {feeError ? (
              <View style={styles.feeError}>
                <InlineNotice tone="red">{feeError}</InlineNotice>
                <SmallTextButton
                  title={t('withdraw.recalculateFee')}
                  onPress={() => setFeeRequestNonce(current => current + 1)}
                />
              </View>
            ) : null}
            {amountExceedsBalance ? (
              <InlineNotice tone="red">
                {t('withdraw.insufficientFunding')}
              </InlineNotice>
            ) : null}
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            {message ? (
              <InlineNotice tone="green">{message}</InlineNotice>
            ) : null}
            {step === 'form' ? (
              <View style={styles.buttonWrap}>
                <PrimaryButton
                  title={
                    submitting
                      ? t('withdraw.submitting')
                      : t('withdraw.submitRequest')
                  }
                  disabled={submitDisabled}
                  onPress={submitDraft}
                />
              </View>
            ) : null}
          </ActionCard>

          {draft ? (
            <ActionCard>
              <Text style={styles.cardTitle}>{t('withdraw.requestTitle')}</Text>
              <InfoRow
                label={t('withdraw.orderNo')}
                value={String(draft.withdrawId)}
              />
              <InfoRow
                label={t('assetAction.status')}
                value={confirmationUncertain ? t('withdraw.confirmPendingTitle') : mapWithdrawStatus(draft.status, t)}
                tone="gold"
              />
              <InfoRow label={t('assetAction.coin')} value={draft.symbol} />
              <InfoRow
                label={t('assetAction.network')}
                value={draft.chainKey}
              />
              <InfoRow
                label={t('assetAction.address')}
                value={maskMiddle(draft.toAddress)}
                mono
              />
              <InfoRow
                label={t('assetAction.amount')}
                value={`${draft.amount} ${draft.symbol}`}
              />
              <InfoRow
                label={t('assetAction.fee')}
                value={`${draft.feeEstimate} ${draft.feeCoin}`}
              />
              {draft.needManualReview ? (
                <InlineNotice>{t('withdraw.manualReviewNotice')}</InlineNotice>
              ) : null}
            </ActionCard>
          ) : null}

          {step === 'verify' && draft ? (
            <ActionCard>
              <Text style={styles.cardTitle}>
                {t('withdraw.emailVerification')}
              </Text>
              <Text style={styles.desc}>{t('withdraw.emailDescription')}</Text>
              <View style={styles.codeRow}>
                <PrimaryButton
                  title={
                    cooldown > 0
                      ? t('withdraw.resendAfter', { seconds: cooldown })
                      : codeSending
                      ? t('withdraw.sending')
                      : t('withdraw.sendCode')
                  }
                  disabled={codeSending || cooldown > 0}
                  onPress={sendCode}
                />
              </View>
              <ActionTextField
                label={t('withdraw.emailCode')}
                maxLength={6}
                value={code}
                onChangeText={value =>
                  setCode(value.replace(/\D/g, '').slice(0, 6))
                }
                keyboardType="number-pad"
                placeholder={t('withdraw.codePlaceholder')}
              />
              <View style={styles.buttonWrap}>
                <PrimaryButton
                  title={
                    confirming
                      ? t('withdraw.confirming')
                      : t('withdraw.confirmSubmit')
                  }
                  disabled={confirming || !code.trim()}
                  onPress={confirm}
                />
              </View>
            </ActionCard>
          ) : null}

          {step === 'done' && draft ? (
            <ActionCard>
              <Text style={styles.cardTitle}>
                {t('withdraw.currentResult')}
              </Text>
              {sendError ? <InlineNotice>{t('withdraw.sendPending')}</InlineNotice> : null}
              <Text style={styles.resultText}>
                {confirmationUncertain ? t('withdraw.confirmPending') : message ||
                  t('withdraw.currentStatus', {
                    status: mapWithdrawStatus(draft.status, t),
                  })}
              </Text>
              <View style={styles.buttonWrap}>
                {confirmationUncertain ? <PrimaryButton
                  title={t('withdraw.refreshConfirmation')}
                  disabled={confirming}
                  onPress={() => recoverConfirmation(draft.withdrawId, flowGenerationRef.current)}
                /> : null}
                <PrimaryButton
                  title={t('withdraw.continue')}
                  disabled={confirming || confirmationUncertain}
                  variant="secondary"
                  onPress={() => {
                    if (confirmLockRef.current || recoveryLockRef.current || confirmationUncertainRef.current) return;
                    setAmount('');
                    setAddress('');
                    resetFlow();
                  }}
                />
              </View>
            </ActionCard>
          ) : null}
        </>
      )}
      {isLoggedIn ? <ActionCard>
        <SmallTextButton title={t('withdraw.records')} onPress={() => setShowRecords(value => !value)} />
      </ActionCard> : null}
      {isLoggedIn && showRecords ? <WithdrawRecords
        revision={recordsRevision} disabled={confirming}
        onChange={onRecordsChange} onMutation={loadData}
      /> : null}
    </AppScreen>
  );
}

export function isWithdrawOptionEnabled(item: AssetChainOption) {
  return (
    item.enabled !== false &&
    item.assetEnabled !== false &&
    item.chainEnabled !== false &&
    item.assetChainEnabled !== false &&
    item.withdrawEnabled !== false &&
    item.memoRequired !== true
  );
}

export function buildWithdrawFeeFingerprint({
  address,
  amount,
  network,
  symbol,
}: {
  address: string;
  amount: string;
  network: string;
  symbol: string;
}) {
  return JSON.stringify([
    symbol.trim().toUpperCase(),
    network.trim().toLowerCase(),
    amount.trim(),
    address.trim(),
  ]);
}

export function isWithdrawFeeReady(
  fee: WithdrawFeeEstimate | null,
  feeFingerprint: string | null,
  currentFingerprint: string,
) {
  return Boolean(
    fee && feeFingerprint && feeFingerprint === currentFingerprint,
  );
}

const styles = StyleSheet.create({
  infoBlock: {
    marginTop: 12,
  },
  feeError: {
    alignItems: 'flex-start',
    gap: 6,
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
  desc: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  codeRow: {
    marginTop: 12,
  },
  resultText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
});
