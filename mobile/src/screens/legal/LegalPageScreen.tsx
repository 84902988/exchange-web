import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ArrowLeft } from 'lucide-react-native';
import { fetchLegalPage, type LegalPageContent } from '../../api/legal';
import AppScreen from '../../components/common/AppScreen';
import ContentLanguageNotice from '../../components/common/ContentLanguageNotice';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'LegalPage'>;

export default function LegalPageScreen({ navigation, route }: Props) {
  const { pageKey } = route.params;
  const { locale, t } = useLanguage();
  const fallbackTitle = t(
    pageKey === 'terms'
      ? 'legal.terms'
      : pageKey === 'privacy'
      ? 'legal.privacy'
      : 'legal.risk',
  );
  const [page, setPage] = useState<LegalPageContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const contentBlocks = useMemo(
    () => splitLegalContent(page?.content || ''),
    [page?.content],
  );

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);

    fetchLegalPage(pageKey, { locale, signal: controller.signal })
      .then(nextPage => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setPage(nextPage);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setPage(null);
        setLoading(false);
        setError(t('legal.loadError'));
      });
  }, [locale, pageKey, t]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  return (
    <AppScreen contentStyle={styles.screen} scroll={false}>
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
        <Text
          maxFontSizeMultiplier={1.3}
          numberOfLines={1}
          style={styles.headerTitle}
        >
          {page?.title || fallbackTitle}
        </Text>
      </View>

      {loading ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>
            {t('legal.loading', { title: fallbackTitle })}
          </Text>
        </View>
      ) : null}

      {!loading && error ? (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>{t('legal.loadFailed')}</Text>
          <Text style={styles.stateDescription}>{error}</Text>
          <Pressable
            accessibilityLabel={t('legal.retryA11y', { title: fallbackTitle })}
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

      {!loading && page ? (
        <FlatList
          contentContainerStyle={styles.article}
          data={contentBlocks}
          initialNumToRender={4}
          keyExtractor={(_, index) => `${page.key}-${index}`}
          ListHeaderComponent={
            <View>
              <Text maxFontSizeMultiplier={1.35} style={styles.title}>
                {page.title}
              </Text>
              <ContentLanguageNotice responseLocale={page.locale} />
            </View>
          }
          maxToRenderPerBatch={4}
          removeClippedSubviews={Platform.OS === 'android'}
          renderItem={({ item }) => (
            <Text maxFontSizeMultiplier={1.4} selectable style={styles.content}>
              {item}
            </Text>
          )}
          showsVerticalScrollIndicator={false}
          style={styles.list}
          updateCellsBatchingPeriod={50}
          windowSize={5}
        />
      ) : null}
    </AppScreen>
  );
}

export function splitLegalContent(content: string, maxBlockLength = 4000) {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const blocks: string[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    let remaining = paragraph.trim();
    while (remaining.length > maxBlockLength) {
      let cut = remaining.lastIndexOf('\n', maxBlockLength);
      if (cut < maxBlockLength / 2) {
        cut = remaining.lastIndexOf('。', maxBlockLength) + 1;
      }
      if (cut < maxBlockLength / 2) cut = maxBlockLength;
      blocks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) blocks.push(remaining);
  }
  return blocks;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  screen: { flex: 1 },
  list: { flex: 1 },
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
  stateTitle: { ...typography.semibold, color: colors.text, fontSize: 15 },
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
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  retryText: { ...typography.semibold, color: colors.black, fontSize: 13 },
  article: {
    paddingBottom: 24,
    marginTop: 14,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  title: {
    ...typography.screenTitle,
    color: colors.text,
    fontSize: 22,
    lineHeight: 30,
  },
  content: {
    ...typography.regular,
    marginTop: 14,
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 24,
  },
});
