import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Gift, Sparkles } from 'lucide-react-native';
import {
  fetchActivity,
  formatActivityDateTime,
  type MobileActivity,
} from '../../api/activity';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import {
  ActionCard,
  ActionHeader,
  InfoRow,
  InlineNotice,
  RefreshButton,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import { resolveActivityCtaTarget } from '../../navigation/activityRoute';
import type { RootStackParamList } from '../../navigation/types';
import {useLanguage} from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ActivityDetail'>;

export default function ActivityDetailScreen({ navigation, route }: Props) {
  const { activityId, title: routeTitle } = route.params;
  const {locale, t} = useLanguage();
  const [activity, setActivity] = useState<MobileActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(false);

    fetchActivity(activityId, {locale, signal: controller.signal})
      .then(nextActivity => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setActivity(nextActivity);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setActivity(null);
        setLoading(false);
        setError(true);
      });
  }, [activityId, locale]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  const ctaTarget = useMemo(
    () => resolveActivityCtaTarget(activity?.ctaUrl || ''),
    [activity?.ctaUrl],
  );
  const openCta = useCallback(() => {
    if (!ctaTarget) return;
    if (ctaTarget.type === 'auth') {
      navigation.navigate('Auth', { screen: ctaTarget.screen });
      return;
    }
    if (ctaTarget.type === 'main') {
      if (ctaTarget.screen === 'Assets') {
        navigation.navigate('Main', {
          screen: 'Assets',
          params: ctaTarget.params,
        });
        return;
      }
      navigation.navigate('Main', { screen: ctaTarget.screen });
      return;
    }
    navigation.navigate(ctaTarget.screen);
  }, [ctaTarget, navigation]);

  return (
    <AppScreen>
      <ActionHeader
        title={activity?.title || routeTitle || t('activity.detailTitle')}
        subtitle={t('activity.detailSubtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={navigation.goBack}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading}
            onPress={load}
          />
        }
      />

      {loading && !activity ? (
        <StateCard
          title={t('activity.detailLoading')}
          description={t('common.pleaseWait')}
        />
      ) : null}
      {!loading && error ? (
        <StateCard
          title={t('activity.detailUnavailable')}
          description={t('activity.detailUnavailableDescription')}
          actionTitle={t('common.reload')}
          onActionPress={load}
        />
      ) : null}

      {!error && activity ? (
        <>
          <View style={styles.hero}>
            <View style={styles.heroIcon}>
              <Gift color={colors.gold} size={28} strokeWidth={2.1} />
            </View>
            <Text style={styles.badge}>{t('activity.ongoing')}</Text>
            <Text style={styles.title}>{activity.title}</Text>
            {activity.subtitle ? (
              <Text style={styles.subtitle}>{activity.subtitle}</Text>
            ) : null}
            {activity.description ? (
              <Text style={styles.description}>{activity.description}</Text>
            ) : null}
          </View>

          <ActionCard>
            <View style={styles.rewardHeader}>
              <Sparkles color={colors.gold} size={18} />
              <Text style={styles.sectionTitle}>
                {t('activity.rewardTitle')}
              </Text>
            </View>
            <Text style={styles.reward}>
              {activity.rewardText || t('activity.rewardFallback')}
            </Text>
          </ActionCard>

          <ActionCard>
            <Text style={styles.sectionTitle}>{t('activity.timeTitle')}</Text>
            <InfoRow
              label={t('activity.startTime')}
              value={formatActivityDateTime(activity.startAt)}
            />
            <InfoRow
              label={t('activity.endTime')}
              value={formatActivityDateTime(activity.endAt)}
            />
          </ActionCard>

          <ActionCard>
            <Text style={styles.sectionTitle}>{t('activity.rulesTitle')}</Text>
            {activity.detailContent ? (
              <Text selectable style={styles.rules}>
                {activity.detailContent}
              </Text>
            ) : (
              <InlineNotice>{t('activity.rulesPending')}</InlineNotice>
            )}
          </ActionCard>

          <InlineNotice>{t('activity.disclaimer')}</InlineNotice>

          {ctaTarget ? (
            <View style={styles.cta}>
              <PrimaryButton
                title={activity.ctaText || t('activity.participate')}
                onPress={openCta}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: 12,
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.36)',
    backgroundColor: 'rgba(214,168,50,0.09)',
    paddingHorizontal: 18,
    paddingVertical: 22,
  },
  heroIcon: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    backgroundColor: colors.goldSoft,
  },
  badge: {
    ...typography.medium,
    marginTop: 12,
    color: colors.green,
    fontSize: 11,
  },
  title: {
    ...typography.bold,
    marginTop: 7,
    color: colors.text,
    fontSize: 23,
    lineHeight: 31,
    textAlign: 'center',
  },
  subtitle: {
    ...typography.medium,
    marginTop: 7,
    color: colors.gold,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  description: {
    ...typography.regular,
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
  },
  rewardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 14 },
  reward: {
    ...typography.bold,
    marginTop: 12,
    color: colors.gold,
    fontSize: 20,
  },
  rules: {
    ...typography.regular,
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 22,
  },
  cta: { marginTop: 14 },
});
