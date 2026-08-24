import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BookOpen } from 'lucide-react-native';
import { fetchHelpArticle, type MobileHelpArticle } from '../../api/help';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import {
  ActionCard,
  ActionHeader,
  RefreshButton,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { useAuth } from '../../store/authStore';
import {useLanguage} from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'HelpArticle'>;

export default function HelpArticleScreen({ navigation, route }: Props) {
  const { articleId, title: routeTitle } = route.params;
  const { isLoggedIn } = useAuth();
  const {locale, t} = useLanguage();
  const [article, setArticle] = useState<MobileHelpArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
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

      fetchHelpArticle(articleId, {
        locale,
        signal: controller.signal,
        forceRefresh,
      })
        .then(nextArticle => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setArticle(nextArticle);
          setLoading(false);
        })
        .catch(() => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setArticle(null);
          setLoading(false);
          setError(true);
        });
    },
    [articleId, locale],
  );

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

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
        title={article?.title || routeTitle || t('help.articleTitle')}
        subtitle={t('help.articleSubtitle')}
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

      {loading && !article ? (
        <StateCard
          title={t('help.articleLoading')}
          description={t('common.pleaseWait')}
        />
      ) : null}
      {!loading && error ? (
        <StateCard
          title={t('help.articleUnavailable')}
          description={t('help.articleUnavailableDescription')}
          actionTitle={t('common.reload')}
          onActionPress={() => load(true)}
        />
      ) : null}

      {!error && article ? (
        <>
          <View style={styles.hero}>
            <View style={styles.heroIcon}>
              <BookOpen color={colors.gold} size={24} strokeWidth={2.1} />
            </View>
            <Text style={styles.category}>{article.categoryTitle}</Text>
            <Text style={styles.title}>{article.title}</Text>
            {article.summary ? (
              <Text style={styles.summary}>{article.summary}</Text>
            ) : null}
            {article.tags.length > 0 ? (
              <View style={styles.tags}>
                {article.tags.map(tag => (
                  <Text key={tag} style={styles.tag}>
                    {tag}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>

          <ActionCard>
            <Text selectable style={styles.content}>
              {article.content}
            </Text>
          </ActionCard>

          <View style={styles.supportAction}>
            <PrimaryButton
              title={t('help.contactSupport')}
              variant="secondary"
              onPress={openSupport}
            />
          </View>
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
    borderColor: 'rgba(214,168,50,0.32)',
    backgroundColor: 'rgba(214,168,50,0.08)',
    paddingHorizontal: 18,
    paddingVertical: 22,
  },
  heroIcon: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 25,
    backgroundColor: colors.goldSoft,
  },
  category: {
    ...typography.medium,
    marginTop: 12,
    color: colors.gold,
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
  summary: {
    ...typography.regular,
    marginTop: 10,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
  },
  tags: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 7,
  },
  tag: {
    ...typography.medium,
    color: colors.goldMuted,
    fontSize: 10,
    borderRadius: 9,
    backgroundColor: colors.goldSoft,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  content: {
    ...typography.regular,
    color: colors.text,
    fontSize: 14,
    lineHeight: 24,
  },
  supportAction: { marginTop: 14 },
});
