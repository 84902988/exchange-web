import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ArrowRight,
  FileText,
  Landmark,
  LockKeyhole,
  Mail,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react-native';
import {
  fetchAboutPage,
  type MobileAboutPage,
  type MobileAboutSection,
  type MobileAboutSectionId,
} from '../../api/about';
import { fetchPublicSupportContact } from '../../api/siteContact';
import {
  ActionHeader,
  RefreshButton,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import ContentLanguageNotice from '../../components/common/ContentLanguageNotice';
import type { RootStackParamList } from '../../navigation/types';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'AboutPage'>;

const REQUIRED_SECTION_IDS = new Set<MobileAboutSectionId>([
  'who',
  'story',
  'vision',
  'mission',
  'values',
]);

const COMPLIANCE_LICENSE_NOTICES: Array<{title: string; subtitle: string}> = [];

export default function AboutPageScreen({ navigation }: Props) {
  const { locale, t } = useLanguage();
  const [page, setPage] = useState<MobileAboutPage | null>(null);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
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

      Promise.allSettled([
        fetchAboutPage({ locale, signal: controller.signal, forceRefresh }),
        fetchPublicSupportContact({ locale, signal: controller.signal }),
      ])
        .then(([pageResult, contactResult]) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setSupportEmail(
            contactResult.status === 'fulfilled'
              ? contactResult.value.email
              : null,
          );
          if (pageResult.status === 'rejected') {
            setPage(null);
            setLoading(false);
            setError(true);
            return;
          }
          setPage(pageResult.value);
          setLoading(false);
        })
        .catch(() => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setPage(null);
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

  const visibleSectionIds = new Set(page?.sections.map(section => section.id));
  const hasPartialContent = Array.from(REQUIRED_SECTION_IDS).some(
    sectionId => !visibleSectionIds.has(sectionId),
  );

  return (
    <AppScreen contentStyle={styles.screen} scroll={false}>
      <ActionHeader
        title={t('about.title')}
        subtitle="Exchange"
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

      {loading ? (
        <StateCard
          title={t('about.loading')}
          description={t('about.loadingDescription')}
        />
      ) : null}

      {!loading && error ? (
        <StateCard
          title={t('about.unavailable')}
          description={t('about.unavailableDescription')}
          actionTitle={t('common.reload')}
          onActionPress={() => load(true)}
        />
      ) : null}

      {!loading && page && page.sections.length === 0 ? (
        <StateCard
          title={t('about.empty')}
          description={t('about.emptyDescription')}
          actionTitle={t('common.refresh')}
          onActionPress={() => load(true)}
        />
      ) : null}

      {!loading && page && page.sections.length > 0 ? (
        <FlatList
          contentContainerStyle={styles.listContent}
          data={page.sections}
          initialNumToRender={5}
          keyExtractor={section => section.id}
          ListHeaderComponent={
            <View style={styles.hero}>
              <View style={styles.heroIcon}>
                <Landmark color={colors.gold} size={28} strokeWidth={2} />
              </View>
              <Text selectable style={styles.heroTitle}>
                {page.title}
              </Text>
              {page.subtitle ? (
                <Text selectable style={styles.heroSubtitle}>
                  {page.subtitle}
                </Text>
              ) : null}
              <Text style={styles.source}>
                {t('common.platformContentSource')}
              </Text>
              <ContentLanguageNotice responseLocale={page.locale} />
            </View>
          }
          ListFooterComponent={
            <View>
              {hasPartialContent ? (
                <Text style={styles.partial}>{t('about.partial')}</Text>
              ) : null}
              <ComplianceLicenseNotices />
              {supportEmail ? (
                <View style={styles.contactSection}>
                  <Text style={styles.contactSectionTitle}>
                    {t('about.contact')}
                  </Text>
                  <View
                    accessibilityLabel={t('about.supportEmailA11y', {
                      email: supportEmail,
                    })}
                    style={styles.contactCard}
                  >
                    <View style={styles.contactIcon}>
                      <Mail color={colors.gold} size={20} strokeWidth={2.1} />
                    </View>
                    <View style={styles.contactCopy}>
                      <Text style={styles.contactLabel}>
                        {t('about.supportEmail')}
                      </Text>
                      <Text selectable style={styles.contactValue}>
                        {supportEmail}
                      </Text>
                    </View>
                  </View>
                </View>
              ) : null}
              <View style={styles.policySection}>
                <Text style={styles.policySectionTitle}>
                  {t('about.policies')}
                </Text>
                <PolicyEntry
                  Icon={ShieldAlert}
                  accessibilityLabel={t('about.riskA11y')}
                  description={t('about.riskDescription')}
                  onPress={() =>
                    navigation.navigate('LegalPage', { pageKey: 'risk' })
                  }
                  title={t('legal.risk')}
                />
                <PolicyEntry
                  Icon={FileText}
                  accessibilityLabel={t('about.termsA11y')}
                  description={t('about.termsDescription')}
                  onPress={() =>
                    navigation.navigate('LegalPage', { pageKey: 'terms' })
                  }
                  title={t('legal.terms')}
                />
                <PolicyEntry
                  Icon={LockKeyhole}
                  accessibilityLabel={t('about.privacyA11y')}
                  description={t('about.privacyDescription')}
                  onPress={() =>
                    navigation.navigate('LegalPage', { pageKey: 'privacy' })
                  }
                  title={t('legal.privacy')}
                />
              </View>
            </View>
          }
          maxToRenderPerBatch={5}
          removeClippedSubviews={Platform.OS === 'android'}
          renderItem={({ item }) => <AboutSection section={item} />}
          showsVerticalScrollIndicator={false}
          style={styles.list}
          windowSize={7}
        />
      ) : null}
    </AppScreen>
  );
}

function ComplianceLicenseNotices() {
  return (
    <View testID="about-compliance-licenses" style={styles.licenseSection}>
      <Text style={styles.licenseEyebrow}>LICENSES &amp; REGULATIONS</Text>
      <Text style={styles.licenseTitle}>全球合规牌照</Text>
      <View style={styles.licenseList}>
        {COMPLIANCE_LICENSE_NOTICES.map(item => (
          <View
            accessibilityLabel={`${item.title}，${item.subtitle}`}
            key={`${item.title}-${item.subtitle}`}
            style={styles.licenseItem}
          >
            <Text selectable style={styles.licenseItemTitle}>
              {item.title}
            </Text>
            <Text selectable style={styles.licenseItemSubtitle}>
              {item.subtitle}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function AboutSection({ section }: { section: MobileAboutSection }) {
  return (
    <View style={styles.sectionCard}>
      {section.eyebrow ? (
        <Text selectable style={styles.eyebrow}>
          {section.eyebrow}
        </Text>
      ) : null}
      <Text selectable style={styles.sectionTitle}>
        {section.title}
      </Text>
      {section.body.map((paragraph, index) => (
        <Text
          key={`${section.id}-paragraph-${index}`}
          selectable
          style={styles.paragraph}
        >
          {paragraph}
        </Text>
      ))}
      {section.items.length > 0 ? (
        <View style={styles.itemList}>
          {section.items.map(item => (
            <View key={item.title} style={styles.itemCard}>
              <Text selectable style={styles.itemTitle}>
                {item.title}
              </Text>
              {item.body.map((paragraph, index) => (
                <Text
                  key={`${item.title}-paragraph-${index}`}
                  selectable
                  style={styles.itemBody}
                >
                  {paragraph}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PolicyEntry({
  Icon,
  accessibilityLabel,
  description,
  onPress,
  title,
}: {
  Icon: LucideIcon;
  accessibilityLabel: string;
  description: string;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.policyEntry,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.policyIcon}>
        <Icon color={colors.warning} size={20} strokeWidth={2.1} />
      </View>
      <View style={styles.policyCopy}>
        <Text style={styles.policyTitle}>{title}</Text>
        <Text style={styles.policyDescription}>{description}</Text>
      </View>
      <ArrowRight color={colors.textMuted} size={17} strokeWidth={2.1} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  screen: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingBottom: 28 },
  hero: {
    marginTop: 12,
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.32)',
    backgroundColor: 'rgba(214,168,50,0.08)',
    paddingHorizontal: 18,
    paddingVertical: 24,
  },
  heroIcon: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 27,
    backgroundColor: colors.goldSoft,
  },
  heroTitle: {
    ...typography.screenTitle,
    marginTop: 14,
    color: colors.text,
    fontSize: 24,
    lineHeight: 32,
    textAlign: 'center',
  },
  heroSubtitle: {
    ...typography.regular,
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  source: {
    ...typography.caption,
    marginTop: 12,
    color: colors.textSubtle,
    fontSize: 10,
  },
  sectionCard: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 16,
  },
  eyebrow: {
    ...typography.semibold,
    color: colors.gold,
    fontSize: 11,
    letterSpacing: 1,
  },
  sectionTitle: {
    ...typography.bold,
    marginTop: 6,
    color: colors.text,
    fontSize: 19,
    lineHeight: 27,
  },
  paragraph: {
    ...typography.regular,
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 24,
  },
  itemList: { marginTop: 4 },
  itemCard: {
    marginTop: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    padding: 13,
  },
  itemTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  itemBody: {
    ...typography.regular,
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 21,
  },
  partial: {
    ...typography.caption,
    marginTop: 14,
    color: colors.textSubtle,
    fontSize: 11,
    textAlign: 'center',
  },
  licenseSection: {
    marginTop: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 16,
  },
  licenseEyebrow: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  licenseTitle: {
    ...typography.bold,
    marginTop: 8,
    color: colors.text,
    fontSize: 19,
    lineHeight: 27,
  },
  licenseList: {
    marginTop: 10,
    gap: 9,
  },
  licenseItem: {
    minHeight: 58,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.cardAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  licenseItemTitle: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  licenseItemSubtitle: {
    ...typography.regular,
    marginTop: 3,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 15,
  },
  contactSection: { marginTop: 14 },
  contactSectionTitle: {
    ...typography.bold,
    marginBottom: 2,
    color: colors.text,
    fontSize: 16,
  },
  contactCard: {
    minHeight: 64,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
  },
  contactIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.goldSoft,
  },
  contactCopy: { flex: 1, marginLeft: 11 },
  contactLabel: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 11,
  },
  contactValue: {
    ...typography.bold,
    marginTop: 4,
    color: colors.text,
    fontSize: 14,
  },
  policySection: {
    marginTop: 14,
  },
  policySectionTitle: {
    ...typography.bold,
    marginBottom: 2,
    color: colors.text,
    fontSize: 16,
  },
  policyEntry: {
    minHeight: 64,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(243,179,74,0.28)',
    backgroundColor: 'rgba(243,179,74,0.08)',
    paddingHorizontal: 13,
  },
  policyIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: 'rgba(243,179,74,0.13)',
  },
  policyCopy: { flex: 1, marginHorizontal: 11 },
  policyTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  policyDescription: {
    ...typography.regular,
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 11,
  },
});
