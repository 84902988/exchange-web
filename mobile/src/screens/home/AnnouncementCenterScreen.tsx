import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ArrowRight, Bell, Pin } from 'lucide-react-native';
import {
  fetchMobileAnnouncements,
  type MobileAnnouncementSummary,
} from '../../api/mobileContent';
import AppScreen from '../../components/common/AppScreen';
import {
  ActionHeader,
  RefreshButton,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

const PAGE_SIZE = 20;

type Props = NativeStackScreenProps<RootStackParamList, 'AnnouncementCenter'>;

export default function AnnouncementCenterScreen({ navigation }: Props) {
  const { locale, t } = useLanguage();
  const [items, setItems] = useState<MobileAnnouncementSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const itemsRef = useRef<MobileAnnouncementSummary[]>([]);

  const loadFirstPage = useCallback(() => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(false);
    setLoadMoreError(false);

    fetchMobileAnnouncements({
      page: 1,
      pageSize: PAGE_SIZE,
      locale,
      signal: controller.signal,
    })
      .then(result => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        itemsRef.current = result.items;
        setItems(result.items);
        setTotal(result.total);
        setPage(result.page);
        setPages(result.pages);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        itemsRef.current = [];
        setItems([]);
        setTotal(0);
        setPage(0);
        setPages(1);
        setLoading(false);
        setError(true);
      });
  }, [locale]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || error || page >= pages) {
      return;
    }
    const generation = generationRef.current;
    const nextPage = page + 1;
    setLoadingMore(true);
    setLoadMoreError(false);

    fetchMobileAnnouncements({
      page: nextPage,
      pageSize: PAGE_SIZE,
      locale,
    })
      .then(result => {
        if (generation !== generationRef.current) {
          return;
        }
        const knownIds = new Set(itemsRef.current.map(item => item.id));
        if (result.items.some(item => knownIds.has(item.id))) {
          setLoadMoreError(true);
          return;
        }
        const merged = [...itemsRef.current, ...result.items];
        itemsRef.current = merged;
        setItems(merged);
        setTotal(result.total);
        setPage(result.page);
        setPages(result.pages);
      })
      .catch(() => {
        if (generation === generationRef.current) {
          setLoadMoreError(true);
        }
      })
      .finally(() => {
        if (generation === generationRef.current) {
          setLoadingMore(false);
        }
      });
  }, [error, loading, loadingMore, locale, page, pages]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [loadFirstPage]);

  return (
    <AppScreen scroll={false} contentStyle={styles.screen}>
      <ActionHeader
        title={t('announcement.title')}
        subtitle={t('announcement.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={navigation.goBack}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading}
            onPress={loadFirstPage}
          />
        }
      />
      {loading && items.length === 0 ? (
        <StateCard
          title={t('announcement.loading')}
          description={t('common.pleaseWait')}
        />
      ) : null}
      {!loading && error ? (
        <StateCard
          title={t('announcement.unavailable')}
          description={t('announcement.unavailableDescription')}
          actionTitle={t('common.reload')}
          onActionPress={loadFirstPage}
        />
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <StateCard
          title={t('announcement.empty')}
          description={t('announcement.emptyDescription')}
        />
      ) : null}
      {!error && items.length > 0 ? (
        <FlatList
          contentContainerStyle={styles.list}
          data={items}
          keyExtractor={item => item.id}
          ListHeaderComponent={
            <View style={styles.summaryRow}>
              <Text style={styles.summaryTitle}>{t('announcement.all')}</Text>
              <Text style={styles.summaryCount}>
                {t('announcement.count', { count: total })}
              </Text>
            </View>
          }
          ListFooterComponent={
            page < pages ? (
              <View style={styles.footer}>
                <Pressable
                  accessibilityLabel={t('announcement.loadMoreA11y')}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: loadingMore }}
                  android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
                  disabled={loadingMore}
                  onPress={loadMore}
                  style={({ pressed }) => [
                    styles.moreButton,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text style={styles.moreText}>
                    {loadingMore
                      ? t('common.loading')
                      : t('announcement.loadMore')}
                  </Text>
                </Pressable>
                {loadMoreError ? (
                  <Text style={styles.moreError}>
                    {t('announcement.moreUnavailable')}
                  </Text>
                ) : null}
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <AnnouncementCard
              item={item}
              onPress={() =>
                navigation.navigate('MobileAnnouncementDetail', {
                  announcementId: item.id,
                  title: item.title,
                })
              }
            />
          )}
          showsVerticalScrollIndicator={false}
        />
      ) : null}
    </AppScreen>
  );
}

function AnnouncementCard({
  item,
  onPress,
}: {
  item: MobileAnnouncementSummary;
  onPress: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('announcement.detailA11y', { title: item.title })}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.cardTop}>
        <View style={styles.icon}>
          <Bell color={colors.gold} size={18} strokeWidth={2.1} />
        </View>
        <Text style={styles.category}>
          {item.categoryLabel || t('announcement.category')}
        </Text>
        {item.isPinned ? (
          <View style={styles.pinned}>
            <Pin color={colors.gold} size={12} />
            <Text style={styles.pinnedText}>{t('announcement.pinned')}</Text>
          </View>
        ) : null}
        <ArrowRight color={colors.textMuted} size={18} />
      </View>
      <Text style={styles.cardTitle}>{item.title}</Text>
      {item.summary ? (
        <Text numberOfLines={2} style={styles.cardSummary}>
          {item.summary}
        </Text>
      ) : null}
      <Text style={styles.date}>
        {formatAnnouncementDate(
          item.publishedAt,
          t('announcement.timePending'),
        )}
      </Text>
    </Pressable>
  );
}

export function formatAnnouncementDate(
  value: string | null,
  pendingLabel = '发布时间待定',
) {
  if (!value) return pendingLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return pendingLabel;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours(),
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  screen: { flex: 1 },
  list: { paddingBottom: 20 },
  summaryRow: {
    marginTop: 14,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  summaryTitle: { ...typography.bold, color: colors.text, fontSize: 16 },
  summaryCount: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
  },
  card: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 14,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center' },
  icon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.goldSoft,
  },
  category: {
    ...typography.medium,
    flex: 1,
    marginLeft: 9,
    color: colors.textMuted,
    fontSize: 11,
  },
  pinned: {
    marginRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  pinnedText: { ...typography.medium, color: colors.gold, fontSize: 10 },
  cardTitle: {
    ...typography.bold,
    marginTop: 12,
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
  },
  cardSummary: {
    ...typography.regular,
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 19,
  },
  date: {
    ...typography.caption,
    marginTop: 10,
    color: colors.textSubtle,
    fontSize: 10,
  },
  footer: { alignItems: 'center', paddingVertical: 16 },
  moreButton: {
    minWidth: 112,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  moreText: { ...typography.medium, color: colors.gold, fontSize: 12 },
  moreError: {
    ...typography.caption,
    marginTop: 8,
    color: colors.red,
    fontSize: 10,
  },
});
