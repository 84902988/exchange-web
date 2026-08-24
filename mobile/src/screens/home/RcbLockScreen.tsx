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
import { CalendarClock, LockKeyhole, ShieldCheck } from 'lucide-react-native';
import {
  createRcbLock,
  fetchRcbLocks,
  fetchVipOverview,
  releaseMaturedRcbLocks,
  type RcbLockRecord,
  type VipLevel,
  type VipOverview,
} from '../../api/vip';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SmallTextButton,
  StateCard,
  formatAmount,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'RcbLock'>;

export default function RcbLockScreen() {
  const navigation = useNavigation<Navigation>();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [overview, setOverview] = useState<VipOverview | null>(null);
  const [locks, setLocks] = useState<RcbLockRecord[]>([]);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const confirmationOpenRef = useRef(false);
  const submitLockRef = useRef(false);

  const load = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextLocks] = await Promise.all([
        fetchVipOverview({ signal: controller.signal }),
        fetchRcbLocks({ signal: controller.signal }),
      ]);
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      ) {
        return;
      }
      setOverview(nextOverview);
      setLocks(nextLocks);
      try {
        const release = await releaseMaturedRcbLocks();
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        ) {
          return;
        }
        if (release.releasedCount > 0) {
          const [releasedOverview, releasedLocks] = await Promise.all([
            fetchVipOverview({ signal: controller.signal }),
            fetchRcbLocks({ signal: controller.signal }),
          ]);
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            generation !== loadGenerationRef.current
          ) {
            return;
          }
          setOverview(releasedOverview);
          setLocks(releasedLocks);
          setNotice(
            tRef.current('rcbLock.releasedNotice', {
              amount: formatAmount(release.releasedAmount, 8),
            }),
          );
        }
      } catch {
        // The reconciler is a safety net. A temporary rollout mismatch must
        // not hide the existing balance or lock history from the user.
      }
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      ) {
        return;
      }
      setError(localizeRcbLockError(requestError, tRef.current, 'load'));
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
      }
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        generation === loadGenerationRef.current
      ) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadGenerationRef.current += 1;
      confirmationOpenRef.current = false;
      submitLockRef.current = false;
    };
  }, [load]);

  const parsedAmount = parsePositiveAmount(amount);
  const targetLevel = useMemo(
    () => pickTargetLevel(overview, parsedAmount),
    [overview, parsedAmount],
  );
  const lockPeriodDays = targetLevel?.lockPeriodDays ?? 365;
  const available = Number(overview?.rcbFundingAvailable ?? '0');
  const canSubmit =
    Boolean(overview) &&
    parsedAmount !== null &&
    parsedAmount <= available &&
    lockPeriodDays > 0 &&
    !submitting;

  const submit = useCallback(() => {
    if (
      !canSubmit ||
      parsedAmount === null ||
      confirmationOpenRef.current ||
      submitLockRef.current
    ) {
      return;
    }
    confirmationOpenRef.current = true;
    const normalizedAmount = amount.trim();
    Alert.alert(
      tRef.current('rcbLock.confirmTitle'),
      tRef.current('rcbLock.confirmDescription', {
        amount: formatAmount(normalizedAmount, 8),
        days: lockPeriodDays,
      }),
      [
        {
          text: tRef.current('rcbLock.cancel'),
          style: 'cancel',
          onPress: () => {
            confirmationOpenRef.current = false;
          },
        },
        {
          text: tRef.current('rcbLock.confirm'),
          style: 'default',
          onPress: async () => {
            confirmationOpenRef.current = false;
            if (submitLockRef.current) return;
            submitLockRef.current = true;
            setSubmitting(true);
            setError('');
            setNotice('');
            try {
              const result = await createRcbLock({
                amount: normalizedAmount,
                lockPeriodDays,
              });
              if (!mountedRef.current) return;
              setAmount('');
              setNotice(
                tRef.current('rcbLock.successNotice', {
                  amount: formatAmount(result.lock.lockAmount, 8),
                }),
              );
              const [nextOverview, nextLocks] = await Promise.all([
                fetchVipOverview(),
                fetchRcbLocks(),
              ]);
              if (!mountedRef.current) return;
              setOverview(nextOverview);
              setLocks(nextLocks);
            } catch (requestError) {
              if (!mountedRef.current) return;
              setError(
                localizeRcbLockError(requestError, tRef.current, 'submit'),
              );
            } finally {
              submitLockRef.current = false;
              if (mountedRef.current) setSubmitting(false);
            }
          },
        },
      ],
    );
  }, [amount, canSubmit, lockPeriodDays, parsedAmount]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('rcbLock.title')}
        subtitle={t('rcbLock.subtitle')}
        onBack={() => navigation.goBack()}
        right={
          <RefreshButton disabled={loading || submitting} onPress={load} />
        }
      />

      {loading && !overview ? (
        <StateCard
          title={t('rcbLock.loading')}
          description={t('rcbLock.loadingDescription')}
        />
      ) : overview ? (
        <>
          <View style={styles.hero}>
            <View style={styles.heroHeader}>
              <View style={styles.heroIcon}>
                <LockKeyhole color={colors.gold} size={23} strokeWidth={2.1} />
              </View>
              <View style={styles.heroTitleWrap}>
                <Text style={styles.eyebrow}>
                  {t('rcbLock.accountEyebrow')}
                </Text>
                <Text style={styles.heroTitle}>
                  {t('rcbLock.accountTitle')}
                </Text>
              </View>
              <View style={styles.levelBadge}>
                <Text style={styles.levelBadgeText}>
                  {overview.effectiveLevelCode ?? t('rcbLock.regularUser')}
                </Text>
              </View>
            </View>
            <View style={styles.balanceGrid}>
              <View style={styles.balanceItem}>
                <Text style={styles.balanceLabel}>
                  {t('rcbLock.fundingAvailable')}
                </Text>
                <Text style={styles.balanceValue}>
                  {formatAmount(overview.rcbFundingAvailable, 8)}
                </Text>
                <Text style={styles.balanceUnit}>RCB</Text>
              </View>
              <View style={styles.balanceDivider} />
              <View style={styles.balanceItem}>
                <Text style={styles.balanceLabel}>
                  {t('rcbLock.currentLocked')}
                </Text>
                <Text style={styles.balanceValue}>
                  {formatAmount(overview.rcbLocked, 8)}
                </Text>
                <Text style={styles.balanceUnit}>RCB</Text>
              </View>
            </View>
          </View>

          {notice ? <InlineNotice tone="green">{notice}</InlineNotice> : null}
          {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}

          <ActionCard>
            <View style={styles.cardHeadingRow}>
              <View>
                <Text style={styles.cardTitle}>{t('rcbLock.newLock')}</Text>
                <Text style={styles.cardSubtitle}>
                  {t('rcbLock.newLockSubtitle')}
                </Text>
              </View>
              <ShieldCheck color={colors.gold} size={21} />
            </View>
            <ActionTextField
              label={t('rcbLock.amountLabel')}
              value={amount}
              onChangeText={value => setAmount(normalizeAmountInput(value))}
              placeholder={t('rcbLock.amountPlaceholder')}
              keyboardType="decimal-pad"
              maxLength={40}
              right={
                <View style={styles.inputActions}>
                  <Text style={styles.inputUnit}>RCB</Text>
                  <SmallTextButton
                    title={t('rcbLock.all')}
                    disabled={!overview.rcbFundingAvailable}
                    onPress={() =>
                      setAmount(overview.rcbFundingAvailable ?? '')
                    }
                  />
                </View>
              }
            />

            <View style={styles.previewBox}>
              <InfoRow
                label={t('rcbLock.targetLevel')}
                value={targetLevel?.levelName ?? t('rcbLock.belowThreshold')}
                tone={targetLevel ? 'gold' : undefined}
              />
              <InfoRow
                label={t('rcbLock.lockPeriod')}
                value={t('rcbLock.days', { count: lockPeriodDays })}
              />
              <InfoRow
                label={t('rcbLock.estimatedExpiry')}
                value={formatFutureDate(lockPeriodDays)}
              />
            </View>

            {parsedAmount !== null && parsedAmount > available ? (
              <InlineNotice tone="red">
                {t('rcbLock.insufficientBalance')}
              </InlineNotice>
            ) : (
              <InlineNotice>{t('rcbLock.riskNotice')}</InlineNotice>
            )}
            <View style={styles.submitWrap}>
              <PrimaryButton
                title={
                  submitting
                    ? t('rcbLock.submitting')
                    : t('rcbLock.confirmLock')
                }
                disabled={!canSubmit}
                onPress={submit}
              />
            </View>
          </ActionCard>

          <Text style={styles.sectionTitle}>{t('rcbLock.rulesTitle')}</Text>
          <View style={styles.ruleList}>
            {overview.svipLevels
              .filter(level => level.minLockAmount && level.lockPeriodDays)
              .map(level => (
                <RuleRow key={level.levelCode} level={level} t={t} />
              ))}
          </View>

          <Text style={styles.sectionTitle}>{t('rcbLock.recordsTitle')}</Text>
          {locks.length === 0 ? (
            <StateCard
              title={t('rcbLock.emptyRecords')}
              description={t('rcbLock.emptyRecordsDescription')}
            />
          ) : (
            locks.map(item => (
              <LockRecordCard key={item.id} item={item} t={t} />
            ))
          )}
        </>
      ) : error ? (
        <StateCard
          title={t('rcbLock.unavailable')}
          description={error}
          actionTitle={t('rcbLock.reload')}
          onActionPress={load}
        />
      ) : null}
    </AppScreen>
  );
}

function RuleRow({ level, t }: { level: VipLevel; t: Translator }) {
  return (
    <View style={styles.ruleRow}>
      <View style={styles.ruleHeader}>
        <View style={styles.ruleLevel}>
          <Text style={styles.ruleLevelName}>{level.levelName}</Text>
          <Text style={styles.ruleLevelCode}>{level.levelCode}</Text>
        </View>
      </View>
      <View style={styles.ruleDetails}>
        <RuleMetric
          label={t('rcbLock.minimumLock')}
          value={`${formatAmount(level.minLockAmount, 4)} RCB`}
        />
        <RuleMetric
          label={t('rcbLock.lockPeriod')}
          value={t('rcbLock.days', { count: level.lockPeriodDays ?? 0 })}
        />
        {level.userLimit !== null && level.userLimit !== undefined ? (
          <RuleMetric
            label={t('vip.userLimitLabel')}
            value={t('vip.userLimit', { count: level.userLimit })}
          />
        ) : null}
        {level.dividendRate ? (
          <RuleMetric
            label={t('vip.dividendRateLabel')}
            value={`${formatAmount(String(Number(level.dividendRate) * 100), 4)}%`}
          />
        ) : null}
      </View>
    </View>
  );
}

function RuleMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.ruleMetric}>
      <Text style={styles.ruleMetricValue}>{value}</Text>
      <Text style={styles.ruleMetricLabel}>{label}</Text>
    </View>
  );
}

function LockRecordCard({ item, t }: { item: RcbLockRecord; t: Translator }) {
  const status = getStatusPresentation(item.status, t);
  return (
    <ActionCard style={styles.recordCard}>
      <View style={styles.recordHeader}>
        <View style={styles.recordAmountWrap}>
          <CalendarClock color={colors.gold} size={18} />
          <Text style={styles.recordAmount}>
            {formatAmount(item.lockAmount, 8)} RCB
          </Text>
        </View>
        <View
          style={[styles.statusBadge, { backgroundColor: status.background }]}
        >
          <Text style={[styles.statusText, { color: status.color }]}>
            {status.label}
          </Text>
        </View>
      </View>
      <View style={styles.recordDetails}>
        <InfoRow
          label={t('rcbLock.lockPeriod')}
          value={t('rcbLock.days', { count: item.lockPeriodDays })}
        />
        <InfoRow
          label={t('rcbLock.startTime')}
          value={formatDateTime(item.startTime)}
        />
        <InfoRow
          label={t('rcbLock.endTime')}
          value={formatDateTime(item.endTime)}
        />
        <InfoRow label={t('rcbLock.level')} value={item.currentSvip ?? '--'} />
      </View>
    </ActionCard>
  );
}

export function pickTargetLevel(
  overview: VipOverview | null,
  amount: number | null,
) {
  if (!overview || amount === null) return null;
  const total = Number(overview.rcbLocked ?? '0') + amount;
  return (
    overview.svipLevels
      .filter(level => {
        const minimum = Number(level.minLockAmount ?? '0');
        return minimum > 0 && Number.isFinite(minimum) && total >= minimum;
      })
      .sort((left, right) => right.sortOrder - left.sortOrder)[0] ?? null
  );
}

function parsePositiveAmount(value: string) {
  if (!/^(?:\d+)(?:\.\d{0,18})?$/.test(value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeAmountInput(value: string) {
  const normalized = value.replace(/[^\d.]/g, '');
  const [whole = '', ...fractions] = normalized.split('.');
  const fraction = fractions.join('').slice(0, 18);
  return fractions.length > 0 ? `${whole}.${fraction}` : whole;
}

function formatFutureDate(days: number) {
  const date = new Date(Date.now() + Math.max(0, days) * 86400000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateTime(value: string | null) {
  if (!value) return '--';
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '--';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours(),
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getStatusPresentation(status: RcbLockRecord['status'], t: Translator) {
  if (status === 'LOCKED') {
    return {
      label: t('rcbLock.statusLocked'),
      color: colors.gold,
      background: colors.goldSoft,
    };
  }
  if (status === 'UNLOCKED') {
    return {
      label: t('rcbLock.statusUnlocked'),
      color: colors.green,
      background: 'rgba(25,195,125,0.14)',
    };
  }
  if (status === 'EXPIRED') {
    return {
      label: t('rcbLock.statusExpired'),
      color: colors.textMuted,
      background: colors.cardAlt,
    };
  }
  return {
    label: t('rcbLock.statusCanceled'),
    color: colors.red,
    background: 'rgba(240,90,90,0.13)',
  };
}

function localizeRcbLockError(
  error: unknown,
  t: Translator,
  phase: 'load' | 'submit',
) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('\u54cd\u5e94\u683c\u5f0f\u65e0\u6548')) {
    return t('rcbLock.contractInvalid');
  }
  return toChineseError(
    error,
    phase === 'load' ? t('rcbLock.loadFailed') : t('rcbLock.submitFailed'),
    t,
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.46)',
    backgroundColor: 'rgba(214,168,50,0.09)',
    padding: 16,
  },
  heroHeader: { flexDirection: 'row', alignItems: 'center' },
  heroIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(214,168,50,0.14)',
  },
  heroTitleWrap: { flex: 1, marginLeft: 12 },
  eyebrow: { color: colors.goldMuted, fontSize: 9, letterSpacing: 1.2 },
  heroTitle: {
    ...typography.bold,
    marginTop: 4,
    color: colors.text,
    fontSize: 18,
  },
  levelBadge: {
    borderRadius: 12,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  levelBadgeText: { ...typography.bold, color: colors.gold, fontSize: 11 },
  balanceGrid: { marginTop: 18, flexDirection: 'row', alignItems: 'stretch' },
  balanceItem: { flex: 1 },
  balanceDivider: {
    width: 1,
    marginHorizontal: 14,
    backgroundColor: colors.line,
  },
  balanceLabel: { color: colors.textMuted, fontSize: 11 },
  balanceValue: {
    ...typography.bold,
    marginTop: 7,
    color: colors.text,
    fontSize: 22,
  },
  balanceUnit: { marginTop: 2, color: colors.goldMuted, fontSize: 10 },
  cardHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: { ...typography.bold, color: colors.text, fontSize: 16 },
  cardSubtitle: { marginTop: 4, color: colors.textMuted, fontSize: 11 },
  inputActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inputUnit: { color: colors.textMuted, fontSize: 11 },
  previewBox: {
    marginTop: 14,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 11,
  },
  submitWrap: { marginTop: 14 },
  sectionTitle: {
    ...typography.sectionTitle,
    marginTop: 22,
    marginBottom: 2,
    color: colors.text,
  },
  ruleList: {
    marginTop: 10,
    overflow: 'hidden',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  ruleRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  ruleHeader: { flexDirection: 'row', alignItems: 'center' },
  ruleLevel: { flex: 1 },
  ruleLevelName: { ...typography.bold, color: colors.text, fontSize: 13 },
  ruleLevelCode: { marginTop: 3, color: colors.textSubtle, fontSize: 9 },
  ruleDetails: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 10,
  },
  ruleMetric: { width: '50%' },
  ruleMetricValue: { ...typography.bold, color: colors.text, fontSize: 11 },
  ruleMetricLabel: { marginTop: 3, color: colors.textSubtle, fontSize: 9 },
  recordCard: { padding: 14 },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recordAmountWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordAmount: { ...typography.bold, color: colors.text, fontSize: 15 },
  statusBadge: { borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5 },
  statusText: { ...typography.bold, fontSize: 10 },
  recordDetails: { marginTop: 9 },
});
