import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ArrowRight,
  BookOpen,
  Flame,
  Headphones,
  Search,
} from 'lucide-react-native';
import {
  fetchHelpContent,
  type MobileHelpArticle,
  type MobileHelpContent,
} from '../../api/help';
import AppScreen from '../../components/common/AppScreen';
import {
  ActionHeader,
  RefreshButton,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { useAuth } from '../../store/authStore';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'HelpCenter'>;

export default function HelpCenterScreen({ navigation }: Props) {
  const { isLoggedIn } = useAuth();
  const { locale, t } = useLanguage();
  const [content, setContent] = useState<MobileHelpContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    (forceRefresh = false) => {
      const generation = ++generationRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      setError(false);

      fetchHelpContent({ locale, signal: controller.signal, forceRefresh })
        .then(nextContent => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setContent(nextContent);
          setSelectedCategoryId(current =>
            current &&
            nextContent.categories.some(category => category.id === current)
              ? current
              : null,
          );
          setLoading(false);
        })
        .catch(() => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setContent(null);
          setLoading(false);
          setError(true);
        });
    },
    [locale],
  );

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  const articles = useMemo(
    () => selectHelpArticles(content, query, selectedCategoryId),
    [content, query, selectedCategoryId],
  );
  const sectionTitle = query.trim()
    ? t('help.searchResults')
    : selectedCategoryId
    ? content?.categories.find(category => category.id === selectedCategoryId)
        ?.title || t('help.categoryArticles')
    : t('help.hotArticles');

  const openSupport = useCallback(() => {
    if (isLoggedIn) {
      navigation.navigate('HomeMessageCenter', { initialTab: 'support' });
      return;
    }
    navigation.navigate('Auth', { screen: 'Login' });
  }, [isLoggedIn, navigation]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('help.title')}
        subtitle={t('help.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={navigation.goBack}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading}
            onPress={() => load(true)}
          />
        }
      />

      <Pressable
        accessibilityLabel={t('help.supportA11y')}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
        onPress={openSupport}
        style={({ pressed }) => [
          styles.supportCard,
          pressed ? styles.pressed : null,
        ]}
      >
        <View style={styles.supportIcon}>
          <Headphones color={colors.gold} size={20} strokeWidth={2.1} />
        </View>
        <View style={styles.supportCopy}>
          <Text style={styles.supportTitle}>{t('help.supportTitle')}</Text>
          <Text style={styles.supportDescription}>
            {isLoggedIn ? t('help.supportLoggedIn') : t('help.supportGuest')}
          </Text>
        </View>
        <ArrowRight color={colors.textMuted} size={18} />
      </Pressable>

      {loading && !content ? (
        <StateCard
          title={t('help.loading')}
          description={t('common.pleaseWait')}
        />
      ) : null}
      {!loading && error ? (
        <StateCard
          title={t('help.unavailable')}
          description={t('help.unavailableDescription')}
          actionTitle={t('common.reload')}
          onActionPress={() => load(true)}
        />
      ) : null}
      {!loading && !error && content?.categories.length === 0 ? (
        <StateCard
          title={t('help.empty')}
          description={t('help.emptyDescription')}
        />
      ) : null}

      {!error && content && content.categories.length > 0 ? (
        <>
          <View style={styles.searchWrap}>
            <Search color={colors.textMuted} size={18} strokeWidth={2} />
            <TextInput
              accessibilityLabel={t('help.searchA11y')}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={80}
              onChangeText={setQuery}
              placeholder={t('help.searchPlaceholder')}
              placeholderTextColor={colors.textSubtle}
              returnKeyType="search"
              style={styles.searchInput}
              value={query}
            />
          </View>

          <Text style={styles.sectionLabel}>{t('help.categories')}</Text>
          <ScrollView
            contentContainerStyle={styles.categoryTrack}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            <CategoryChip
              active={selectedCategoryId === null}
              label={t('help.hot')}
              onPress={() => setSelectedCategoryId(null)}
            />
            {content.categories.map(category => (
              <CategoryChip
                active={selectedCategoryId === category.id}
                key={category.id}
                label={category.title}
                onPress={() => setSelectedCategoryId(category.id)}
              />
            ))}
          </ScrollView>

          <Text style={styles.sectionLabel}>{sectionTitle}</Text>
          {articles.length > 0 ? (
            articles.map(article => (
              <ArticleCard
                article={article}
                key={article.id}
                onPress={() =>
                  navigation.navigate('HelpArticle', {
                    articleId: article.id,
                    title: article.title,
                  })
                }
              />
            ))
          ) : (
            <StateCard
              title={t('help.noResults')}
              description={t('help.noResultsDescription')}
            />
          )}
        </>
      ) : null}
    </AppScreen>
  );
}

export function selectHelpArticles(
  content: MobileHelpContent | null,
  query: string,
  selectedCategoryId: string | null,
) {
  if (!content) return [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery) {
    return content.categories
      .flatMap(category => category.articles)
      .filter(article =>
        [
          article.title,
          article.summary,
          article.categoryTitle,
          article.tags.join(' '),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      );
  }
  if (selectedCategoryId) {
    return (
      content.categories.find(category => category.id === selectedCategoryId)
        ?.articles || []
    );
  }
  return content.hotArticles;
}

function CategoryChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('help.categoryA11y', { label })}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.categoryChip,
        active ? styles.categoryChipActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text
        style={[
          styles.categoryChipText,
          active ? styles.categoryChipTextActive : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ArticleCard({
  article,
  onPress,
}: {
  article: MobileHelpArticle;
  onPress: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      accessibilityLabel={t('help.articleA11y', { title: article.title })}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.articleCard,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.articleIcon}>
        {article.hot ? (
          <Flame color={colors.gold} size={19} strokeWidth={2.1} />
        ) : (
          <BookOpen color={colors.gold} size={19} strokeWidth={2.1} />
        )}
      </View>
      <View style={styles.articleCopy}>
        <View style={styles.articleMetaRow}>
          <Text style={styles.categoryName}>{article.categoryTitle}</Text>
          {article.hot ? (
            <Text style={styles.hotBadge}>{t('help.hot')}</Text>
          ) : null}
        </View>
        <Text style={styles.articleTitle}>{article.title}</Text>
        {article.summary ? (
          <Text numberOfLines={2} style={styles.articleSummary}>
            {article.summary}
          </Text>
        ) : null}
      </View>
      <ArrowRight color={colors.textMuted} size={18} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  supportCard: {
    minHeight: 68,
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.3)',
    backgroundColor: 'rgba(214,168,50,0.08)',
    paddingHorizontal: 14,
  },
  supportIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.goldSoft,
  },
  supportCopy: { flex: 1, marginHorizontal: 12 },
  supportTitle: { ...typography.bold, color: colors.text, fontSize: 13 },
  supportDescription: {
    ...typography.regular,
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 11,
  },
  searchWrap: {
    minHeight: 46,
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
  },
  searchInput: {
    ...typography.regular,
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 13,
    paddingVertical: 0,
  },
  sectionLabel: {
    ...typography.bold,
    marginTop: 20,
    marginBottom: 10,
    color: colors.text,
    fontSize: 15,
  },
  categoryTrack: { gap: 8, paddingRight: 4 },
  categoryChip: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
  },
  categoryChipActive: {
    borderColor: colors.gold,
    backgroundColor: colors.goldSoft,
  },
  categoryChipText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
  },
  categoryChipTextActive: { color: colors.gold },
  articleCard: {
    minHeight: 104,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 13,
  },
  articleIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.goldSoft,
  },
  articleCopy: { flex: 1, marginHorizontal: 12 },
  articleMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  categoryName: {
    ...typography.medium,
    color: colors.goldMuted,
    fontSize: 10,
  },
  hotBadge: {
    ...typography.medium,
    color: colors.gold,
    fontSize: 9,
    borderRadius: 8,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  articleTitle: {
    ...typography.bold,
    marginTop: 5,
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  articleSummary: {
    ...typography.regular,
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
});
