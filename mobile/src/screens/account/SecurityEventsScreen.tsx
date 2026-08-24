import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import {
  KeyRound,
  LogOut,
  MailCheck,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react-native';
import { fetchMySecurityEvents, type SecurityEventItem } from '../../api';
import {
  ActionHeader,
  InlineNotice,
  RefreshButton,
  StateCard,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import { useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

export function formatSecurityEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatSecurityEventDevice(userAgent: string, t?: Translator) {
  if (/okhttp|exchangemobile.*android/i.test(userAgent)) {
    return 'ExchangeMobile / Android';
  }
  if (/cfnetwork|iphone|ipad|exchangemobile.*ios/i.test(userAgent)) {
    return 'ExchangeMobile / iOS';
  }
  if (/chrome/i.test(userAgent)) return 'Chrome';
  if (/safari/i.test(userAgent)) return 'Safari';
  return userAgent.trim()
    ? t?.('securityEvents.otherClient') || '其他客户端'
    : t?.('securityEvents.unknownClient') || '未知客户端';
}

export function describeSecurityEvent(item: SecurityEventItem, t?: Translator) {
  const detail = (key: string) => String(item.details[key] ?? '').trim();
  const count = (key: string) =>
    typeof item.details[key] === 'number' ? Number(item.details[key]) : 0;
  switch (item.eventType) {
    case 'EMAIL_VERIFIED':
      return {
        title: t?.('securityEvents.emailVerifiedTitle') || '登录邮箱已验证',
        description:
          item.details.source === 'registration'
            ? t?.('securityEvents.emailVerifiedRegister') ||
              '注册时已完成邮箱验证'
            : detail('email') ||
              t?.('securityEvents.emailVerifiedDescription') ||
              '当前登录邮箱已完成验证',
        tone: 'green' as const,
      };
    case 'EMAIL_CHANGED':
      return {
        title: t?.('securityEvents.emailChangedTitle') || '登录邮箱已更换',
        description:
          detail('old_email') && detail('new_email')
            ? `${detail('old_email')} → ${detail('new_email')}`
            : t?.('securityEvents.emailChangedDescription') ||
              '登录邮箱已通过安全验证完成更换',
        tone: 'gold' as const,
      };
    case 'PASSWORD_CHANGED':
      return {
        title: t?.('securityEvents.passwordChangedTitle') || '登录密码已修改',
        description:
          count('revoked_sessions') > 0
            ? t?.('securityEvents.passwordChangedSessions', {
                count: count('revoked_sessions'),
              }) || `已撤销 ${count('revoked_sessions')} 个登录会话`
            : t?.('securityEvents.passwordChangedDescription') ||
              '密码已由登录账户主动修改',
        tone: 'gold' as const,
      };
    case 'PASSWORD_RESET':
      return {
        title: t?.('securityEvents.passwordResetTitle') || '登录密码已重置',
        description:
          count('revoked_sessions') > 0
            ? t?.('securityEvents.passwordChangedSessions', {
                count: count('revoked_sessions'),
              }) || `已撤销 ${count('revoked_sessions')} 个登录会话`
            : t?.('securityEvents.passwordResetDescription') ||
              '密码已通过邮箱验证重置',
        tone: 'red' as const,
      };
    case 'SESSION_REVOKED':
      return {
        title: t?.('securityEvents.sessionRevokedTitle') || '已退出一台设备',
        description:
          detail('target_device') ||
          t?.('securityEvents.sessionRevokedDescription') ||
          '一个其他登录会话已失效',
        tone: 'gold' as const,
      };
    case 'SESSIONS_REVOKED':
      return {
        title: t?.('securityEvents.othersRevokedTitle') || '已退出其他设备',
        description:
          t?.('securityEvents.othersRevokedDescription', {
            count: count('revoked_count'),
          }) || `已撤销 ${count('revoked_count')} 个登录会话`,
        tone: 'gold' as const,
      };
  }
}

function EventIcon({ item }: { item: SecurityEventItem }) {
  const description = describeSecurityEvent(item);
  const color =
    description.tone === 'green'
      ? colors.green
      : description.tone === 'red'
      ? colors.red
      : colors.gold;
  if (item.eventType.startsWith('EMAIL_')) {
    return <MailCheck color={color} size={19} />;
  }
  if (item.eventType.startsWith('PASSWORD_')) {
    return <KeyRound color={color} size={19} />;
  }
  if (item.eventType.includes('SESSION')) {
    return <LogOut color={color} size={19} />;
  }
  return <ShieldCheck color={color} size={19} />;
}

function EventRow({ item }: { item: SecurityEventItem }) {
  const { t } = useLanguage();
  const description = describeSecurityEvent(item, t);
  return (
    <View style={styles.eventRow}>
      <View style={styles.eventIcon}>
        <EventIcon item={item} />
      </View>
      <View style={styles.eventBody}>
        <Text style={styles.eventTitle}>{description.title}</Text>
        <Text numberOfLines={2} style={styles.eventDescription}>
          {description.description}
        </Text>
        <Text numberOfLines={1} style={styles.eventMeta}>
          {formatSecurityEventDevice(item.userAgent, t)} · {item.ipAddress}
        </Text>
        <Text style={styles.eventTime}>
          {formatSecurityEventTime(item.createdAt)}
        </Text>
      </View>
    </View>
  );
}

export default function SecurityEventsScreen({
  navigation,
}: {
  navigation: any;
}) {
  const { t } = useLanguage();
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const [items, setItems] = useState<SecurityEventItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (cursor: number | null, append: boolean, signal?: AbortSignal) => {
      if (append && loadingMoreRef.current) return;
      const generation = ++generationRef.current;
      if (append) {
        loadingMoreRef.current = true;
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError('');
      try {
        const page = await fetchMySecurityEvents(20, cursor, signal);
        if (
          !mountedRef.current ||
          signal?.aborted ||
          generation !== generationRef.current
        )
          return;
        setItems(current => {
          if (!append) return page.items;
          const existing = new Set(current.map(item => item.id));
          return [
            ...current,
            ...page.items.filter(item => !existing.has(item.id)),
          ];
        });
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (requestError) {
        if (
          !mountedRef.current ||
          signal?.aborted ||
          generation !== generationRef.current
        )
          return;
        setError(toChineseError(requestError, t('securityEvents.loadError')));
      } finally {
        if (append) loadingMoreRef.current = false;
        if (
          mountedRef.current &&
          !signal?.aborted &&
          generation === generationRef.current
        ) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    load(null, false, controller.signal).catch(() => undefined);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      loadingMoreRef.current = false;
      controller.abort();
    };
  }, [load]);

  return (
    <AppScreen scroll={false} contentStyle={styles.screen}>
      <FlatList
        contentContainerStyle={styles.listContent}
        data={items}
        initialNumToRender={8}
        keyExtractor={item => String(item.id)}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        maxToRenderPerBatch={8}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item }) => <EventRow item={item} />}
        showsVerticalScrollIndicator={false}
        updateCellsBatchingPeriod={40}
        windowSize={7}
        ListHeaderComponent={
          <>
            <ActionHeader
              title={t('securityEvents.title')}
              subtitle={t('securityEvents.subtitle')}
              backAccessibilityLabel={t('common.back')}
              onBack={() => navigation.goBack()}
              right={
                <RefreshButton
                  accessibilityLabel={t('common.refresh')}
                  disabled={loading || loadingMore}
                  onPress={() => load(null, false)}
                />
              }
            />
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            {loading && items.length === 0 ? (
              <StateCard
                title={t('securityEvents.loading')}
                description={t('common.pleaseWait')}
              />
            ) : items.length === 0 ? (
              <StateCard
                title={t('securityEvents.empty')}
                description={t('securityEvents.emptyDescription')}
                actionTitle={t('common.reload')}
                onActionPress={() => load(null, false)}
              />
            ) : (
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>
                    {t('securityEvents.recent')}
                  </Text>
                  <Text style={styles.sectionHint}>
                    {t('securityEvents.sortHint')}
                  </Text>
                </View>
                <RefreshCw color={colors.textSubtle} size={16} />
              </View>
            )}
          </>
        }
        ListFooterComponent={
          <>
            {hasMore && nextCursor ? (
              <View style={styles.loadMore}>
                <PrimaryButton
                  title={
                    loadingMore ? t('common.loading') : t('common.loadMore')
                  }
                  variant="secondary"
                  disabled={loadingMore || loading}
                  onPress={() => load(nextCursor, true)}
                />
              </View>
            ) : null}
            <InlineNotice>{t('securityEvents.warning')}</InlineNotice>
          </>
        }
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: { paddingBottom: 16 },
  sectionHeader: {
    marginTop: 14,
    marginBottom: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  sectionHint: { marginTop: 4, color: colors.textMuted, fontSize: 11 },
  eventRow: {
    minHeight: 104,
    marginTop: 10,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    backgroundColor: colors.card,
  },
  eventIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cardAlt,
  },
  eventBody: { flex: 1, minWidth: 0 },
  eventTitle: { ...typography.bold, color: colors.text, fontSize: 14 },
  eventDescription: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  eventMeta: { marginTop: 7, color: colors.textSubtle, fontSize: 10 },
  eventTime: { marginTop: 4, color: colors.textSubtle, fontSize: 10 },
  loadMore: { marginTop: 14 },
});
