import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ArrowRight, Crown, LockKeyhole, Sparkles } from 'lucide-react-native';
import {
  fetchVipFeePreference,
  fetchVipOverview,
  updateVipFeePreference,
  type VipLevel,
  type VipOverview,
} from '../../api/vip';
import AppScreen from '../../components/common/AppScreen';
import {
  ActionCard,
  ActionHeader,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SmallTextButton,
  StateCard,
  formatAmount,
} from '../../components/assets/action/ActionPrimitives';
import { useLanguage, type Translator } from '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import { colors, typography } from '../../theme';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'VipCenter'>;

export default function VipCenterScreen() {
  const navigation = useNavigation<Navigation>();
  const { t } = useLanguage();
  const tRef = useRef(t);
  const [overview, setOverview] = useState<VipOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feePreference, setFeePreference] = useState<boolean | null>(null);
  const [feePreferenceLoading, setFeePreferenceLoading] = useState(true);
  const [feePreferenceSaving, setFeePreferenceSaving] = useState(false);
  const [feePreferenceMessage, setFeePreferenceMessage] = useState('');
  const [feePreferenceError, setFeePreferenceError] = useState('');
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const preferenceGenerationRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const overviewControllerRef = useRef<AbortController | null>(null);
  const preferenceControllerRef = useRef<AbortController | null>(null);
  const feePreferenceSavingRef = useRef(false);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const loadFeePreference = useCallback(async () => {
    preferenceControllerRef.current?.abort();
    const controller = new AbortController();
    preferenceControllerRef.current = controller;
    const generation = ++preferenceGenerationRef.current;
    setFeePreferenceLoading(true);
    setFeePreferenceMessage('');
    setFeePreferenceError('');
    try {
      const preference = await fetchVipFeePreference({
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== preferenceGenerationRef.current
      ) {
        return;
      }
      setFeePreference(preference.useRcbFee);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== preferenceGenerationRef.current
      ) {
        return;
      }
      setFeePreference(null);
      const translate = tRef.current;
      setFeePreferenceError(
        translate('vip.feePreferenceLoadError', {
          message: getVipRequestError(
            requestError,
            translate,
            translate('common.networkError'),
          ),
        }),
      );
    } finally {
      if (preferenceControllerRef.current === controller) {
        preferenceControllerRef.current = null;
      }
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        generation === preferenceGenerationRef.current
      ) {
        setFeePreferenceLoading(false);
      }
    }
  }, []);

  const load = useCallback(async () => {
    overviewControllerRef.current?.abort();
    const controller = new AbortController();
    overviewControllerRef.current = controller;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError('');
    const preferencePromise = loadFeePreference();
    try {
      const nextOverview = await fetchVipOverview({
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      ) {
        return;
      }
      setOverview(nextOverview);
    } catch (requestError) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        generation !== loadGenerationRef.current
      ) {
        return;
      }
      setOverview(null);
      const translate = tRef.current;
      setError(
        getVipRequestError(
          requestError,
          translate,
          translate('vip.loadFailed'),
        ),
      );
    } finally {
      if (overviewControllerRef.current === controller) {
        overviewControllerRef.current = null;
      }
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        generation === loadGenerationRef.current
      ) {
        setLoading(false);
      }
      await preferencePromise;
    }
  }, [loadFeePreference]);

  useEffect(() => {
    mountedRef.current = true;
    load().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      overviewControllerRef.current?.abort();
      preferenceControllerRef.current?.abort();
      overviewControllerRef.current = null;
      preferenceControllerRef.current = null;
      loadGenerationRef.current += 1;
      preferenceGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      feePreferenceSavingRef.current = false;
    };
  }, [load]);

  const currentLevel = useMemo(() => findCurrentLevel(overview), [overview]);

  const updateFeePreference = useCallback(
    async (nextValue: boolean) => {
      if (
        feePreference === null ||
        feePreferenceLoading ||
        feePreferenceSaving ||
        feePreferenceSavingRef.current
      ) {
        return;
      }

      const previousValue = feePreference;
      feePreferenceSavingRef.current = true;
      const generation = ++saveGenerationRef.current;
      setFeePreference(nextValue);
      setFeePreferenceSaving(true);
      setFeePreferenceMessage('');
      setFeePreferenceError('');
      try {
        const saved = await updateVipFeePreference(nextValue);
        if (!mountedRef.current || generation !== saveGenerationRef.current) {
          return;
        }
        setFeePreference(saved.useRcbFee);
        const translate = tRef.current;
        setFeePreferenceMessage(
          saved.useRcbFee
            ? translate('vip.feePreferenceEnabled')
            : translate('vip.feePreferenceDisabled'),
        );
      } catch (requestError) {
        if (!mountedRef.current || generation !== saveGenerationRef.current) {
          return;
        }
        setFeePreference(previousValue);
        const translate = tRef.current;
        setFeePreferenceError(
          translate('vip.feePreferenceSaveFailed', {
            message: getVipRequestError(
              requestError,
              translate,
              translate('common.networkError'),
            ),
          }),
        );
      } finally {
        if (generation === saveGenerationRef.current) {
          feePreferenceSavingRef.current = false;
        }
        if (mountedRef.current && generation === saveGenerationRef.current) {
          setFeePreferenceSaving(false);
        }
      }
    },
    [feePreference, feePreferenceLoading, feePreferenceSaving],
  );

  return (
    <AppScreen>
      <ActionHeader
        backAccessibilityLabel={t('common.back')}
        title={t('vip.title')}
        subtitle={t('vip.subtitle')}
        onBack={() => navigation.goBack()}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading || feePreferenceLoading || feePreferenceSaving}
            onPress={load}
          />
        }
      />

      {loading && !overview ? (
        <StateCard
          title={t('vip.loading')}
          description={t('common.pleaseWait')}
        />
      ) : error ? (
        <StateCard
          title={t('vip.unavailable')}
          description={error}
          actionTitle={t('common.reload')}
          onActionPress={load}
        />
      ) : overview ? (
        <>
          <View style={styles.hero}>
            <View style={styles.heroIcon}>
              <Crown color={colors.gold} size={28} strokeWidth={2.1} />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.eyebrow}>{t('vip.currentLevel')}</Text>
              <Text style={styles.level}>
                {currentLevel?.levelName ??
                  overview.effectiveLevelCode ??
                  t('vip.standardUser')}
              </Text>
              <Text style={styles.source}>
                {overview.effectiveFeeSource
                  ? t('vip.feeSource', {
                      source: overview.effectiveFeeSource,
                    })
                  : t('vip.baseFeeSource')}
              </Text>
            </View>
            <Sparkles color={colors.goldMuted} size={22} />
          </View>

          <ActionCard>
            <Text style={styles.cardTitle}>{t('vip.currentBenefits')}</Text>
            <InfoRow
              label={t('vip.spotMaker')}
              value={formatFeePercent(overview.effectiveSpotMakerFee)}
              tone="gold"
            />
            <InfoRow
              label={t('vip.spotTaker')}
              value={formatFeePercent(overview.effectiveSpotTakerFee)}
              tone="gold"
            />
            <InfoRow
              label={t('vip.rcbPayPercent')}
              value={
                overview.rcbFeePayPercent === null
                  ? '--'
                  : `${formatAmount(overview.rcbFeePayPercent, 2)}%`
              }
            />
            <View style={styles.feePreferenceRow}>
              <View style={styles.feePreferenceCopy}>
                <Text style={styles.feePreferenceTitle}>
                  {t('vip.feePreferenceTitle')}
                </Text>
                <Text style={styles.feePreferenceDescription}>
                  {t('vip.feePreferenceDescription')}
                </Text>
              </View>
              <Switch
                accessibilityLabel={t('vip.feePreferenceA11y')}
                accessibilityRole="switch"
                accessibilityState={{
                  checked: feePreference === true,
                  disabled:
                    feePreference === null ||
                    feePreferenceLoading ||
                    feePreferenceSaving,
                  busy: feePreferenceSaving,
                }}
                disabled={
                  feePreference === null ||
                  feePreferenceLoading ||
                  feePreferenceSaving
                }
                trackColor={{
                  false: colors.line,
                  true: 'rgba(214,168,50,0.52)',
                }}
                thumbColor={feePreference ? colors.gold : colors.textMuted}
                value={feePreference === true}
                onValueChange={updateFeePreference}
              />
            </View>
            {feePreferenceLoading ? (
              <Text style={styles.feePreferenceStatus}>
                {t('vip.feePreferenceLoading')}
              </Text>
            ) : null}
            {feePreferenceError ? (
              <>
                <InlineNotice tone="red">{feePreferenceError}</InlineNotice>
                {feePreference === null ? (
                  <View style={styles.feePreferenceRetry}>
                    <SmallTextButton
                      title={t('vip.feePreferenceRetry')}
                      disabled={feePreferenceLoading || feePreferenceSaving}
                      onPress={() => {
                        loadFeePreference().catch(() => undefined);
                      }}
                    />
                  </View>
                ) : null}
              </>
            ) : null}
            {feePreferenceMessage ? (
              <InlineNotice tone="green">{feePreferenceMessage}</InlineNotice>
            ) : null}
          </ActionCard>

          <ActionCard>
            <Text style={styles.cardTitle}>{t('vip.growthData')}</Text>
            <InfoRow
              label={t('vip.volume30d')}
              value={`${formatAmount(overview.volume30d, 2)} USDT`}
            />
            <InfoRow
              label={t('vip.rcbAvailable')}
              value={`${formatAmount(overview.rcbAvailable, 4)} RCB`}
            />
            <InfoRow
              label={t('vip.rcbLocked')}
              value={`${formatAmount(overview.rcbLocked, 4)} RCB`}
            />
            <Pressable
              accessibilityLabel={t('vip.openRcbLock')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              style={({ pressed }) => [
                styles.lockEntry,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => navigation.navigate('RcbLock')}
            >
              <View style={styles.lockEntryIcon}>
                <LockKeyhole color={colors.gold} size={18} strokeWidth={2.2} />
              </View>
              <View style={styles.lockEntryCopy}>
                <Text style={styles.lockEntryTitle}>{t('vip.rcbLocked')}</Text>
                <Text style={styles.lockEntrySubtitle}>
                  {t('vip.rcbLockDescription')}
                </Text>
              </View>
              <ArrowRight color={colors.textMuted} size={18} />
            </Pressable>
            <Pressable
              accessibilityLabel={t('vip.openDividends')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
              style={({ pressed }) => [
                styles.lockEntry,
                pressed ? styles.pressed : null,
              ]}
              onPress={() => navigation.navigate('DividendCenter')}
            >
              <View style={styles.lockEntryIcon}>
                <Sparkles color={colors.gold} size={18} strokeWidth={2.2} />
              </View>
              <View style={styles.lockEntryCopy}>
                <Text style={styles.lockEntryTitle}>{t('vip.dividends')}</Text>
                <Text style={styles.lockEntrySubtitle}>
                  {t('vip.dividendDescription')}
                </Text>
              </View>
              <ArrowRight color={colors.textMuted} size={18} />
            </Pressable>
          </ActionCard>

          <Text style={styles.sectionTitle}>{t('vip.levelFees')}</Text>
          {overview.vipLevels.map(level => (
            <LevelCard
              key={`VIP:${level.levelCode}`}
              active={
                overview.effectiveFeeSource === 'VIP' &&
                level.levelCode === overview.effectiveLevelCode
              }
              level={level}
              t={t}
            />
          ))}
          {overview.svipLevels.map(level => (
            <LevelCard
              key={`SVIP:${level.levelCode}`}
              active={
                overview.effectiveFeeSource === 'SVIP' &&
                level.levelCode === overview.effectiveLevelCode
              }
              level={level}
              t={t}
            />
          ))}
        </>
      ) : null}
    </AppScreen>
  );
}

function LevelCard({
  level,
  active,
  t,
}: {
  level: VipLevel;
  active: boolean;
  t: Translator;
}) {
  const conditions = [
    level.min30dVolume
      ? t('vip.volumeThreshold', {
          amount: formatAmount(level.min30dVolume, 2),
        })
      : null,
    level.minRcbHold
      ? t('vip.rcbThreshold', {
          amount: formatAmount(level.minRcbHold, 2),
        })
      : null,
    level.minLockAmount
      ? t('vip.minimumLock', {
          amount: formatAmount(level.minLockAmount, 2),
        })
      : null,
    level.lockPeriodDays
      ? t('vip.lockPeriod', {
          count: level.lockPeriodDays,
        })
      : null,
    level.userLimit !== null && level.userLimit !== undefined
      ? t('vip.userLimit', { count: level.userLimit })
      : null,
    level.dividendRate
      ? t('vip.dividendRate', {
          rate: formatFeePercent(level.dividendRate),
        })
      : null,
  ].filter(Boolean);
  return (
    <View style={[styles.levelCard, active ? styles.levelCardActive : null]}>
      <View style={styles.levelHeader}>
        <View>
          <Text style={[styles.levelName, active ? styles.activeText : null]}>
            {level.levelName}
          </Text>
          <Text style={styles.levelCode}>{level.levelCode}</Text>
        </View>
        {active ? (
          <Text style={styles.currentBadge}>{t('vip.currentBadge')}</Text>
        ) : null}
      </View>
      <Text style={styles.feeLine}>
        {t('vip.feeLine', {
          maker: formatFeePercent(level.spotMakerFee),
          taker: formatFeePercent(level.spotTakerFee),
        })}
      </Text>
      {conditions.length > 0 ? (
        conditions.map(condition => (
          <Text key={condition} style={styles.condition}>
            {condition}
          </Text>
        ))
      ) : (
        <Text style={styles.condition}>{t('vip.baseLevel')}</Text>
      )}
    </View>
  );
}

function findCurrentLevel(overview: VipOverview | null) {
  if (!overview?.effectiveLevelCode) return null;
  const levels =
    overview.effectiveFeeSource === 'SVIP'
      ? overview.svipLevels
      : overview.vipLevels;
  return levels.find(level => level.levelCode === overview.effectiveLevelCode);
}

export function formatFeePercent(value: string | null) {
  if (value === null) return '--';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  return `${formatAmount(String(numeric * 100), 4)}%`;
}

function getVipRequestError(error: unknown, t: Translator, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  if (/[\u3400-\u9fff]/.test(message)) return message;
  const normalized = message.toLowerCase();
  if (normalized.includes('network') || normalized.includes('timeout')) {
    return t('common.networkError');
  }
  return fallback;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  hero: {
    marginTop: 12,
    minHeight: 132,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.42)',
    backgroundColor: 'rgba(214,168,50,0.1)',
    padding: 18,
  },
  heroIcon: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 26,
    backgroundColor: 'rgba(214,168,50,0.14)',
  },
  heroCopy: { flex: 1 },
  eyebrow: { color: colors.goldMuted, fontSize: 10, letterSpacing: 1.2 },
  level: {
    ...typography.bold,
    marginTop: 5,
    color: colors.text,
    fontSize: 25,
  },
  source: { marginTop: 5, color: colors.textMuted, fontSize: 11 },
  cardTitle: {
    ...typography.bold,
    marginBottom: 6,
    color: colors.text,
    fontSize: 15,
  },
  feePreferenceRow: {
    minHeight: 72,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: 12,
  },
  feePreferenceCopy: { flex: 1 },
  feePreferenceTitle: {
    ...typography.medium,
    color: colors.text,
    fontSize: 13,
  },
  feePreferenceDescription: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 16,
  },
  feePreferenceStatus: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 10,
  },
  feePreferenceRetry: { alignItems: 'flex-start' },
  sectionTitle: {
    ...typography.sectionTitle,
    marginTop: 22,
    marginBottom: 2,
    color: colors.text,
  },
  levelCard: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  levelCardActive: {
    borderColor: colors.gold,
    backgroundColor: 'rgba(214,168,50,0.08)',
  },
  levelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  levelName: { ...typography.bold, color: colors.text, fontSize: 15 },
  activeText: { color: colors.gold },
  levelCode: { marginTop: 2, color: colors.textSubtle, fontSize: 10 },
  currentBadge: {
    color: colors.gold,
    fontSize: 10,
    borderRadius: 10,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  feeLine: { marginTop: 11, color: colors.text, fontSize: 12 },
  condition: {
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  lockEntry: {
    minHeight: 60,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.38)',
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 12,
  },
  lockEntryIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: 'rgba(214,168,50,0.14)',
  },
  lockEntryCopy: { flex: 1, marginHorizontal: 10 },
  lockEntryTitle: { ...typography.bold, color: colors.text, fontSize: 13 },
  lockEntrySubtitle: { marginTop: 3, color: colors.textMuted, fontSize: 10 },
});
