import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ArrowLeft } from 'lucide-react-native';
import { WebView } from 'react-native-webview';
import {
  fetchMobileAnnouncementDetail,
  markMobileAnnouncementRead,
  type MobileAnnouncementDetail,
} from '../../api/mobileContent';
import AppScreen from '../../components/common/AppScreen';
import { API_BASE_URL } from '../../config/env';
import type { RootStackParamList } from '../../navigation/types';
import { useAuth } from '../../store/authStore';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<
  RootStackParamList,
  'MobileAnnouncementDetail'
>;

export default function MobileAnnouncementDetailScreen({
  navigation,
  route,
}: Props) {
  const { announcementId, title: routeTitle } = route.params;
  const { isLoggedIn } = useAuth();
  const { locale, t } = useLanguage();
  const [detail, setDetail] = useState<MobileAnnouncementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readSyncError, setReadSyncError] = useState(false);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const readControllerRef = useRef<AbortController | null>(null);
  const readLockRef = useRef(false);

  const syncRead = useCallback(async (id: string) => {
    if (readLockRef.current) return;
    readLockRef.current = true;
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    const generation = generationRef.current;
    try {
      await markMobileAnnouncementRead(id, { signal: controller.signal });
      if (!controller.signal.aborted && generation === generationRef.current) {
        setReadSyncError(false);
      }
    } catch {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setReadSyncError(true);
      }
    } finally {
      if (readControllerRef.current === controller) {
        readControllerRef.current = null;
        readLockRef.current = false;
      }
    }
  }, []);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    readControllerRef.current?.abort();
    readControllerRef.current = null;
    readLockRef.current = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setReadSyncError(false);

    fetchMobileAnnouncementDetail(announcementId, {
      locale,
      signal: controller.signal,
    })
      .then(nextDetail => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setDetail(nextDetail);
        setLoading(false);
        if (isLoggedIn) {
          syncRead(nextDetail.id).catch(() => undefined);
        }
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setDetail(null);
        setLoading(false);
        setError(t('announcement.loadError'));
      });
  }, [announcementId, isLoggedIn, locale, syncRead, t]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      readControllerRef.current?.abort();
      readControllerRef.current = null;
      readLockRef.current = false;
    };
  }, [load]);

  return (
    <AppScreen
      contentStyle={
        detail?.contentFormat === 'SANITIZED_HTML'
          ? styles.fullHeight
          : undefined
      }
      scroll={detail?.contentFormat !== 'SANITIZED_HTML'}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t('common.back')}
          accessibilityRole="button"
          android_ripple={{
            color: 'rgba(212, 175, 55, 0.12)',
            borderless: true,
          }}
          onPress={navigation.goBack}
          style={({ pressed }) => [
            styles.backButton,
            pressed ? styles.pressed : null,
          ]}
        >
          <ArrowLeft color={colors.text} size={21} strokeWidth={2.2} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {detail?.title || routeTitle}
        </Text>
      </View>

      {loading ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>
            {t('announcement.detailLoading')}
          </Text>
        </View>
      ) : null}

      {!loading && error ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>{t('announcement.loadFailed')}</Text>
          <Text style={styles.stateDescription}>{error}</Text>
          <Pressable
            accessibilityLabel={t('announcement.retryLoadA11y')}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
            onPress={load}
            style={({ pressed }) => [
              styles.retryButton,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : null}

      {!loading && detail ? (
        <View
          style={[
            styles.article,
            detail.contentFormat === 'SANITIZED_HTML'
              ? styles.richArticle
              : null,
          ]}
        >
          <Text style={styles.title}>{detail.title}</Text>
          {detail.summary ? (
            <Text style={styles.summary}>{detail.summary}</Text>
          ) : null}
          {detail.publishedAt ? (
            <Text style={styles.publishedAt}>
              {detail.publishedAt.slice(0, 10)}
            </Text>
          ) : null}
          <View style={styles.divider} />
          {detail.contentFormat === 'SANITIZED_HTML' ? (
            <WebView
              allowFileAccess={false}
              cacheEnabled
              domStorageEnabled={false}
              javaScriptEnabled={false}
              mixedContentMode="never"
              originWhitelist={['about:blank', 'http://*', 'https://*']}
              setSupportMultipleWindows={false}
              source={{
                baseUrl: API_BASE_URL,
                html: buildMobileAnnouncementHtml(detail.content),
              }}
              style={styles.richContent}
            />
          ) : (
            <Text style={styles.content}>{detail.content}</Text>
          )}
        </View>
      ) : null}
      {!loading && detail && readSyncError ? (
        <Pressable
          accessibilityLabel={t('announcement.retryReadA11y')}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
          onPress={() => syncRead(detail.id)}
          style={({ pressed }) => [
            styles.readSyncNotice,
            pressed ? styles.pressed : null,
          ]}
        >
          <Text style={styles.readSyncText}>
            {t('announcement.readSyncError')}
          </Text>
        </Pressable>
      ) : null}
    </AppScreen>
  );
}

export function buildMobileAnnouncementHtml(content: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:#15171c;color:#eef0f4;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
    p{margin:0 0 14px}h1,h2,h3,h4{line-height:1.35;margin:18px 0 10px;color:#fff}ul,ol{padding-left:22px}img{display:block;max-width:100%;height:auto;margin:12px auto;border-radius:8px}
    table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid #343943;padding:7px}a{color:#d6a832;pointer-events:none}blockquote{margin:12px 0;padding:8px 12px;border-left:3px solid #d6a832;background:#1c1f25}
  </style></head><body>${content}</body></html>`;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  fullHeight: {
    flex: 1,
  },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  headerTitle: {
    ...typography.sectionTitle,
    flex: 1,
    color: colors.text,
    fontSize: 16,
  },
  stateCard: {
    marginTop: 20,
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 24,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  stateTitle: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 15,
  },
  stateDescription: {
    ...typography.regular,
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    minWidth: 92,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  retryText: {
    ...typography.semibold,
    color: colors.black,
    fontSize: 13,
  },
  article: {
    marginTop: 14,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  richArticle: {
    flex: 1,
    minHeight: 0,
  },
  title: {
    ...typography.screenTitle,
    color: colors.text,
    fontSize: 22,
    lineHeight: 30,
  },
  summary: {
    ...typography.regular,
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  publishedAt: {
    ...typography.caption,
    marginTop: 10,
    color: colors.textSubtle,
    fontSize: 11,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 16,
    backgroundColor: colors.line,
  },
  content: {
    ...typography.regular,
    color: colors.text,
    fontSize: 15,
    lineHeight: 24,
  },
  richContent: {
    flex: 1,
    minHeight: 240,
    backgroundColor: colors.card,
  },
  readSyncNotice: {
    marginTop: 10,
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: colors.goldSoft,
  },
  readSyncText: {
    ...typography.medium,
    color: colors.gold,
    fontSize: 11,
  },
});
