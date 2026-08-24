import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
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
  SelectChips,
  SmallTextButton,
  StateCard,
  formatAmount,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import {
  fetchAssetAccountBalances,
  type AssetAccountBalance,
} from '../../api/assets';
import {
  createUserTransfer,
  resolveUserTransferRecipient,
  type UserTransferRecipient,
  type UserTransferRecord,
} from '../../api/userTransfer';
import { ApiClientError } from '../../api/client';
import {
  clearPendingUserTransferIntent,
  createPendingUserTransferIntent,
  recoverPendingUserTransferIntent,
  savePendingUserTransferIntent,
  type PendingUserTransferIntent,
} from '../../services/pendingUserTransferIntent';
import { useAuth } from '../../store/authStore';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';
import {
  compareNonNegativeDecimalText,
  isPositiveDecimalText,
} from '../../utils/decimalText';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;

export default function UserTransferScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { isLoggedIn, user } = useAuth();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const ownerKey = user?.id == null ? null : String(user.id);
  const [balances, setBalances] = useState<AssetAccountBalance[]>([]);
  const [coin, setCoin] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [resolvedRecipient, setResolvedRecipient] =
    useState<UserTransferRecipient | null>(null);
  const [resolvedRecipientEmail, setResolvedRecipientEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [pendingIntent, setPendingIntent] =
    useState<PendingUserTransferIntent | null>(null);
  const [result, setResult] = useState<UserTransferRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mountedRef = useRef(true);
  const dataControllerRef = useRef<AbortController | null>(null);
  const dataGenerationRef = useRef(0);
  const dataLoadLockRef = useRef(false);
  const resolveControllerRef = useRef<AbortController | null>(null);
  const resolveGenerationRef = useRef(0);
  const resolveLockRef = useRef(false);
  const submitLockRef = useRef(false);
  const confirmationOpenRef = useRef(false);

  const fundingBalances = useMemo(
    () =>
      balances
        .filter(item => item.accountKey === 'funding')
        .sort((left, right) => left.symbol.localeCompare(right.symbol)),
    [balances],
  );
  const coinOptions = useMemo(
    () =>
      fundingBalances.map(item => ({
        value: item.symbol,
        label: item.symbol,
        meta: `${t('userTransfer.available')} ${formatAmount(
          exactAvailable(item),
        )}`,
      })),
    [fundingBalances, t],
  );
  const selectedCoin = pendingIntent?.symbol
    ? pendingIntent.symbol
    : coinOptions.some(item => item.value === coin)
    ? coin
    : coinOptions[0]?.value || '';
  const selectedBalance = fundingBalances.find(
    item => item.symbol === selectedCoin,
  );
  const availableText = selectedBalance ? exactAvailable(selectedBalance) : '0';
  const amountValid = isPositiveDecimalText(amount);
  const amountExceedsBalance =
    compareNonNegativeDecimalText(amount, availableText) === 1;
  const recipientConfirmed = Boolean(
    resolvedRecipient?.canTransfer &&
      resolvedRecipientEmail === normalizedEmail(recipientEmail),
  );
  const fieldsLocked = Boolean(pendingIntent);

  const restoreExactIntent = useCallback(
    async (intent: PendingUserTransferIntent, signal?: AbortSignal) => {
      if (signal?.aborted || !mountedRef.current) return;
      setPendingIntent(intent);
      setCoin(intent.symbol);
      setRecipientEmail(intent.recipientEmail);
      setAmount(intent.amount);
      setRemark(intent.remark || '');
      const recipient = await resolveUserTransferRecipient(
        intent.recipientEmail,
        { signal },
      );
      if (signal?.aborted || !mountedRef.current) return;
      if (
        recipient.userId !== intent.recipientUserId ||
        !recipient.canTransfer
      ) {
        throw new Error(tRef.current('userTransfer.recoveryMismatch'));
      }
      setResolvedRecipient(recipient);
      setResolvedRecipientEmail(
        normalizedEmailForComparison(intent.recipientEmail),
      );
      setMessage(tRef.current('userTransfer.pendingRetry'));
    },
    [],
  );

  const loadData = useCallback(async () => {
    if (
      !isLoggedIn ||
      !ownerKey ||
      !mountedRef.current ||
      dataLoadLockRef.current
    ) {
      return;
    }
    dataLoadLockRef.current = true;
    const generation = ++dataGenerationRef.current;
    const controller = new AbortController();
    dataControllerRef.current?.abort();
    dataControllerRef.current = controller;
    setLoading(true);
    setError('');
    setRecoveryBlocked(false);
    try {
      const [balanceRows, recovery] = await Promise.all([
        fetchAssetAccountBalances({ signal: controller.signal }),
        recoverPendingUserTransferIntent(ownerKey),
      ]);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== dataGenerationRef.current
      ) {
        return;
      }
      setBalances(balanceRows);
      if (recovery.status === 'NOT_FOUND') {
        await restoreExactIntent(recovery.intent, controller.signal);
      } else if (
        recovery.status === 'COMPLETED_CLEARED' &&
        recovery.authority.record
      ) {
        setResult(recovery.authority.record);
        setMessage(tRef.current('userTransfer.completedRecovered'));
      } else if (
        recovery.status === 'COMPLETED_MISMATCH' ||
        recovery.status === 'LOCK_CHANGED'
      ) {
        setRecoveryBlocked(true);
        setError(tRef.current('userTransfer.recoveryMismatch'));
      }
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== dataGenerationRef.current
      ) {
        return;
      }
      setRecoveryBlocked(true);
      setError(
        mapUserTransferError(
          requestError,
          tRef.current('userTransfer.loadFailed'),
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
  }, [isLoggedIn, ownerKey, restoreExactIntent]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isLoggedIn || !ownerKey) {
      setBalances([]);
      setPendingIntent(null);
      setResolvedRecipient(null);
      setResolvedRecipientEmail('');
      setResult(null);
      setError('');
      return undefined;
    }
    loadData().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      dataGenerationRef.current += 1;
      resolveGenerationRef.current += 1;
      dataLoadLockRef.current = false;
      resolveLockRef.current = false;
      confirmationOpenRef.current = false;
      dataControllerRef.current?.abort();
      resolveControllerRef.current?.abort();
      dataControllerRef.current = null;
      resolveControllerRef.current = null;
    };
  }, [isLoggedIn, loadData, ownerKey]);

  const resolveRecipient = useCallback(async () => {
    if (resolveLockRef.current) return;
    const email = normalizedEmail(recipientEmail);
    if (!email) return;
    resolveLockRef.current = true;
    const generation = ++resolveGenerationRef.current;
    const controller = new AbortController();
    resolveControllerRef.current?.abort();
    resolveControllerRef.current = controller;
    setResolving(true);
    setError('');
    setMessage('');
    try {
      const recipient = await resolveUserTransferRecipient(email, {
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== resolveGenerationRef.current
      ) {
        return;
      }
      if (!recipient.canTransfer) {
        throw new Error(tRef.current('userTransfer.recipientUnavailable'));
      }
      setResolvedRecipient(recipient);
      setResolvedRecipientEmail(email);
      setMessage(tRef.current('userTransfer.recipientConfirmed'));
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== resolveGenerationRef.current
      ) {
        return;
      }
      setResolvedRecipient(null);
      setResolvedRecipientEmail('');
      setError(
        mapUserTransferError(
          requestError,
          tRef.current('userTransfer.resolveFailed'),
          tRef.current,
        ),
      );
    } finally {
      if (generation === resolveGenerationRef.current) {
        resolveLockRef.current = false;
        if (resolveControllerRef.current === controller) {
          resolveControllerRef.current = null;
        }
        if (mountedRef.current && !controller.signal.aborted) {
          setResolving(false);
        }
      }
    }
  }, [recipientEmail]);

  const submit = useCallback(async () => {
    if (
      submitLockRef.current ||
      !ownerKey ||
      !selectedCoin ||
      !resolvedRecipient
    ) {
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setError('');
    setMessage('');
    let intent = pendingIntent;
    try {
      if (!intent) {
        intent = createPendingUserTransferIntent({
          ownerKey,
          requestId: createUserTransferRequestId(),
          recipientUserId: resolvedRecipient.userId,
          recipientEmail,
          symbol: selectedCoin,
          amount,
          remark,
        });
        await savePendingUserTransferIntent(intent);
        if (mountedRef.current) setPendingIntent(intent);
      }
      const record = await createUserTransfer({
        requestId: intent.requestId,
        recipientEmail: intent.recipientEmail,
        recipientUserId: intent.recipientUserId,
        symbol: intent.symbol,
        amount: intent.amount,
        remark: intent.remark,
      });
      const cleared = await clearPendingUserTransferIntent(intent);
      if (!cleared)
        throw new Error(tRef.current('userTransfer.recoveryMismatch'));
      if (mountedRef.current) {
        setPendingIntent(null);
        setResult(record);
        setMessage(tRef.current('userTransfer.success'));
        setAmount('');
        setRemark('');
        await loadData();
      }
    } catch (requestError) {
      if (intent) {
        try {
          const recovery = await recoverPendingUserTransferIntent(ownerKey);
          if (
            recovery.status === 'COMPLETED_CLEARED' &&
            recovery.authority.record
          ) {
            if (mountedRef.current) {
              setPendingIntent(null);
              setResult(recovery.authority.record);
              setMessage(tRef.current('userTransfer.completedRecovered'));
              await loadData();
            }
            return;
          }
          if (
            recovery.status === 'COMPLETED_MISMATCH' ||
            recovery.status === 'LOCK_CHANGED'
          ) {
            if (mountedRef.current) {
              setRecoveryBlocked(true);
              setError(tRef.current('userTransfer.recoveryMismatch'));
            }
            return;
          }
          if (
            recovery.status === 'NOT_FOUND' &&
            requestError instanceof ApiClientError &&
            [400, 404].includes(requestError.status || 0)
          ) {
            await clearPendingUserTransferIntent(intent);
            if (mountedRef.current) setPendingIntent(null);
          } else if (recovery.status === 'NOT_FOUND') {
            if (mountedRef.current) {
              setPendingIntent(recovery.intent);
              setMessage(tRef.current('userTransfer.pendingRetry'));
            }
          }
        } catch {
          if (mountedRef.current) {
            setMessage(tRef.current('userTransfer.resultUnknown'));
          }
        }
      }
      if (mountedRef.current) {
        setError(
          mapUserTransferError(
            requestError,
            tRef.current('userTransfer.submitFailed'),
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
    loadData,
    ownerKey,
    pendingIntent,
    recipientEmail,
    remark,
    resolvedRecipient,
    selectedCoin,
  ]);

  const confirmSubmit = useCallback(() => {
    if (confirmationOpenRef.current || submitLockRef.current) return;
    confirmationOpenRef.current = true;
    Alert.alert(
      tRef.current('userTransfer.confirmTitle'),
      tRef.current('userTransfer.confirmMessage', {
        amount: formatAmount(amount),
        symbol: selectedCoin,
        recipient:
          resolvedRecipient?.nickname || resolvedRecipient?.emailMask || '--',
      }),
      [
        {
          text: tRef.current('common.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: tRef.current('userTransfer.confirmAction'),
          onPress: async () => {
            confirmationOpenRef.current = false;
            await submit();
          },
        },
      ],
      {
        onDismiss: () => {
          confirmationOpenRef.current = false;
        },
      },
    );
  }, [amount, resolvedRecipient, selectedCoin, submit]);

  const submitDisabled =
    submitting ||
    recoveryBlocked ||
    !recipientConfirmed ||
    !selectedCoin ||
    !amountValid ||
    amountExceedsBalance;

  return (
    <AppScreen>
      <ActionHeader
        title={t('userTransfer.title')}
        subtitle={t('userTransfer.subtitle')}
        onBack={() => navigation.goBack()}
        right={
          <SmallTextButton
            title={t('userTransfer.records')}
            onPress={() => navigation.navigate('UserTransferRecords')}
          />
        }
      />

      {!isLoggedIn ? (
        <AuthRequiredCard
          onLoginPress={() => navigation.navigate('Auth', { screen: 'Login' })}
        />
      ) : loading ? (
        <StateCard
          title={t('userTransfer.loading')}
          description={t('assetAction.loading')}
        />
      ) : balances.length === 0 ? (
        <StateCard
          title={t('userTransfer.unavailable')}
          description={error || t('userTransfer.noFundingAssets')}
          actionTitle={t('assetAction.retry')}
          onActionPress={loadData}
        />
      ) : (
        <>
          <ActionCard>
            <SelectChips
              label={t('assetAction.coin')}
              value={selectedCoin}
              options={coinOptions.map(option => ({
                ...option,
                disabled: fieldsLocked,
              }))}
              onChange={value => {
                if (fieldsLocked) return;
                setCoin(value);
                setAmount('');
                setResult(null);
              }}
              searchable
            />
            <ActionTextField
              label={t('userTransfer.recipientEmail')}
              value={recipientEmail}
              onChangeText={value => {
                resolveGenerationRef.current += 1;
                resolveLockRef.current = false;
                resolveControllerRef.current?.abort();
                resolveControllerRef.current = null;
                setRecipientEmail(value);
                setResolvedRecipient(null);
                setResolvedRecipientEmail('');
                setResolving(false);
                setResult(null);
                setMessage('');
              }}
              placeholder={t('userTransfer.recipientPlaceholder')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!fieldsLocked}
              maxLength={191}
              right={
                <SmallTextButton
                  title={
                    resolving
                      ? t('userTransfer.resolving')
                      : t('userTransfer.resolve')
                  }
                  disabled={
                    resolving ||
                    fieldsLocked ||
                    !normalizedEmail(recipientEmail)
                  }
                  onPress={resolveRecipient}
                />
              }
            />
            {resolvedRecipient ? (
              <View style={styles.recipientCard}>
                <Text style={styles.recipientName}>
                  {resolvedRecipient.nickname || t('userTransfer.recipient')}
                </Text>
                <Text style={styles.recipientMeta}>
                  {resolvedRecipient.emailMask}
                </Text>
              </View>
            ) : null}
            <ActionTextField
              label={t('assetAction.amount')}
              value={amount}
              onChangeText={value => {
                setAmount(value.replace(/[^0-9.]/g, ''));
                setResult(null);
              }}
              placeholder={t('userTransfer.amountPlaceholder')}
              keyboardType="decimal-pad"
              editable={!fieldsLocked}
              maxLength={85}
              right={
                <SmallTextButton
                  title={t('assetAction.all')}
                  disabled={fieldsLocked}
                  onPress={() =>
                    setAmount(
                      isPositiveDecimalText(availableText) ? availableText : '',
                    )
                  }
                />
              }
            />
            <ActionTextField
              label={t('userTransfer.remark')}
              value={remark}
              onChangeText={setRemark}
              placeholder={t('userTransfer.remarkPlaceholder')}
              editable={!fieldsLocked}
              maxLength={255}
            />
            <View style={styles.infoBlock}>
              <InfoRow
                label={t('userTransfer.available')}
                value={`${formatAmount(availableText)} ${selectedCoin}`}
              />
              <InfoRow
                label={t('assetAction.fee')}
                value={`0 ${selectedCoin}`}
              />
            </View>
            {amountExceedsBalance ? (
              <InlineNotice tone="red">
                {t('userTransfer.insufficient')}
              </InlineNotice>
            ) : null}
            {pendingIntent ? (
              <InlineNotice>{t('userTransfer.pendingRetry')}</InlineNotice>
            ) : null}
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            {message ? (
              <InlineNotice tone="green">{message}</InlineNotice>
            ) : null}
            <View style={styles.buttonWrap}>
              <PrimaryButton
                title={
                  submitting
                    ? t('userTransfer.submitting')
                    : pendingIntent
                    ? t('userTransfer.retryExact')
                    : t('userTransfer.submit')
                }
                disabled={submitDisabled}
                onPress={confirmSubmit}
              />
            </View>
          </ActionCard>

          {result ? (
            <ActionCard>
              <Text style={styles.resultTitle}>{t('userTransfer.result')}</Text>
              <InfoRow
                label={t('userTransfer.transferNo')}
                value={result.transferNo}
                mono
              />
              <InfoRow
                label={t('userTransfer.recipient')}
                value={result.recipientNickname || result.recipientEmailMask}
              />
              <InfoRow
                label={t('assetAction.amount')}
                value={`${formatAmount(result.amount)} ${result.symbol}`}
              />
              <InfoRow
                label={t('assetAction.status')}
                value={t('userTransfer.completed')}
                tone="green"
              />
            </ActionCard>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

function exactAvailable(balance: AssetAccountBalance) {
  return (
    balance.availableText ??
    (Number.isFinite(balance.available) ? String(balance.available) : '0')
  );
}

function normalizedEmail(value: string) {
  const email = normalizedEmailForComparison(value);
  if (
    email.length < 3 ||
    email.length > 191 ||
    !email.includes('@') ||
    /\s/.test(email)
  ) {
    return '';
  }
  return email;
}

function normalizedEmailForComparison(value: string) {
  return value.trim().toLowerCase();
}

function createUserTransferRequestId() {
  return `mobile-${Date.now()}-${Math.random().toString(16).slice(2, 14)}`;
}

function mapUserTransferError(error: unknown, fallback: string, t: Translator) {
  const message = error instanceof Error ? error.message : '';
  const normalized = message.toLowerCase();
  if (normalized.includes('recipient not found')) {
    return t('userTransfer.recipientNotFound');
  }
  if (normalized.includes('cannot transfer to yourself')) {
    return t('userTransfer.cannotSelf');
  }
  if (normalized.includes('status') && normalized.includes('active')) {
    return t('userTransfer.recipientUnavailable');
  }
  return toChineseError(error, fallback, t);
}

const styles = StyleSheet.create({
  recipientCard: {
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(22, 196, 127, 0.28)',
    backgroundColor: 'rgba(22, 196, 127, 0.08)',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  recipientName: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  recipientMeta: {
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 12,
  },
  infoBlock: {
    marginTop: 12,
  },
  buttonWrap: {
    marginTop: 14,
  },
  resultTitle: {
    ...typography.bold,
    marginBottom: 10,
    color: colors.text,
    fontSize: 15,
  },
});
