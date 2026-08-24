import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ArrowRight, Gift, Sparkles } from 'lucide-react-native';
import {
  fetchActivities,
  fetchActivityBanners,
  formatActivityDateTime,
  type MobileActivity,
  type MobileActivityBanner,
} from '../../api/activity';
import AppScreen from '../../components/common/AppScreen';
import {
  ActionHeader,
  RefreshButton,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ActivityCenter'>;

export default function ActivityCenterScreen({ navigation }: Props) {
  const { locale, t } = useLanguage();
  const [activities, setActivities] = useState<MobileActivity[]>([]);
  const [banners, setBanners] = useState<MobileActivityBanner[]>([]);
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

    Promise.allSettled([
      fetchActivities({ locale, signal: controller.signal }),
      fetchActivityBanners({ locale, signal: controller.signal }),
    ])
      .then(([activityResult, bannerResult]) => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setBanners(
          bannerResult.status === 'fulfilled' ? bannerResult.value : [],
        );
        if (activityResult.status === 'rejected') {
          setActivities([]);
          setLoading(false);
          setError(true);
          return;
        }
        setActivities(activityResult.value);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setActivities([]);
        setLoading(false);
        setError(true);
      });
  }, [locale]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('activity.centerTitle')}
        subtitle={t('activity.centerSubtitle')}
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

      {!loading && !error && activities.length > 0 ? (
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Sparkles color={colors.gold} size={24} strokeWidth={2.1} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>
              {banners[0]?.title || t('activity.current')}
            </Text>
            <Text style={styles.heroSubtitle}>
              {banners[0]?.subtitle ||
                t('activity.countSummary', { count: activities.length })}
            </Text>
          </View>
        </View>
      ) : null}

      {loading && activities.length === 0 ? (
        <StateCard
          title={t('activity.loading')}
          description={t('common.pleaseWait')}
        />
      ) : null}
      {!loading && error ? (
        <StateCard
          title={t('activity.unavailable')}
          description={t('activity.unavailableDescription')}
          actionTitle={t('common.reload')}
          onActionPress={load}
        />
      ) : null}
      {!loading && !error && activities.length === 0 ? (
        <StateCard
          title={t('activity.empty')}
          description={t('activity.emptyDescription')}
        />
      ) : null}

      {!error
        ? activities.map(activity => (
            <ActivityCard
              activity={activity}
              key={activity.id}
              onPress={() =>
                navigation.navigate('ActivityDetail', {
                  activityId: activity.id,
                  title: activity.title,
                })
              }
            />
          ))
        : null}
    </AppScreen>
  );
}

function ActivityCard({
  activity,
  onPress,
}: {
  activity: MobileActivity;
  onPress: () => void;
}) {
  const { t } = useLanguage();
  const endText = activity.endAt
    ? t('activity.endsAt', { time: formatActivityDateTime(activity.endAt) })
    : t('activity.longTerm');
  return (
    <Pressable
      accessibilityLabel={t('activity.detailA11y', { title: activity.title })}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.cardTop}>
        <View style={styles.cardIcon}>
          <Gift color={colors.gold} size={20} strokeWidth={2.1} />
        </View>
        <Text style={styles.badge}>{t('activity.ongoing')}</Text>
        <ArrowRight color={colors.textMuted} size={18} />
      </View>
      <Text style={styles.cardTitle}>{activity.title}</Text>
      {activity.subtitle || activity.description ? (
        <Text numberOfLines={2} style={styles.cardDescription}>
          {activity.subtitle || activity.description}
        </Text>
      ) : null}
      <View style={styles.cardBottom}>
        <Text numberOfLines={1} style={styles.reward}>
          {activity.rewardText || t('activity.rewardFallback')}
        </Text>
        <Text style={styles.endTime}>{endText}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  hero: {
    minHeight: 92,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.36)',
    backgroundColor: 'rgba(214,168,50,0.09)',
    padding: 15,
  },
  heroIcon: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
    backgroundColor: colors.goldSoft,
  },
  heroCopy: { flex: 1, marginLeft: 13 },
  heroTitle: { ...typography.bold, color: colors.text, fontSize: 16 },
  heroSubtitle: {
    ...typography.regular,
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  card: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center' },
  cardIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.goldSoft,
  },
  badge: {
    ...typography.medium,
    flex: 1,
    marginLeft: 10,
    color: colors.green,
    fontSize: 11,
  },
  cardTitle: {
    ...typography.bold,
    marginTop: 13,
    color: colors.text,
    fontSize: 17,
  },
  cardDescription: {
    ...typography.regular,
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 19,
  },
  cardBottom: {
    marginTop: 13,
    paddingTop: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  reward: {
    ...typography.bold,
    flex: 1,
    color: colors.gold,
    fontSize: 12,
  },
  endTime: { ...typography.caption, color: colors.textSubtle, fontSize: 10 },
});
