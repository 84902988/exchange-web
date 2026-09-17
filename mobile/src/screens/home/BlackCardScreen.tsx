import {branding} from '../../config/brandingConfig';
import React from 'react';
import {
  Image,
  ImageBackground,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  BadgeCheck,
  CreditCard,
  Landmark,
  Mail,
  Network,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react-native';
import {
  ActionCard,
  ActionHeader,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import {useLanguage, type TranslationKey} from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {colors, typography} from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'BlackCard'>;

const CARD_SUPPORT_EMAIL = branding.blackCard.supportEmail;
const BLACK_CARD_BACKGROUND = branding.blackCard.backgroundUrl ? {uri: branding.blackCard.backgroundUrl} : undefined;
const BLACK_CARD_IMAGE = branding.blackCard.imageUrl ? {uri: branding.blackCard.imageUrl} : require('../../assets/brand/app-logo.png');

const featureItems: Array<{
  Icon: LucideIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    Icon: Landmark,
    titleKey: 'blackCard.marketing.feature1Title',
    descriptionKey: 'blackCard.marketing.feature1Desc',
  },
  {
    Icon: CreditCard,
    titleKey: 'blackCard.marketing.feature2Title',
    descriptionKey: 'blackCard.marketing.feature2Desc',
  },
  {
    Icon: Network,
    titleKey: 'blackCard.marketing.feature3Title',
    descriptionKey: 'blackCard.marketing.feature3Desc',
  },
  {
    Icon: BadgeCheck,
    titleKey: 'blackCard.marketing.feature4Title',
    descriptionKey: 'blackCard.marketing.feature4Desc',
  },
  {
    Icon: ShieldCheck,
    titleKey: 'blackCard.marketing.feature5Title',
    descriptionKey: 'blackCard.marketing.feature5Desc',
  },
  {
    Icon: UsersRound,
    titleKey: 'blackCard.marketing.feature6Title',
    descriptionKey: 'blackCard.marketing.feature6Desc',
  },
];

const stepTwoItemKeys: TranslationKey[] = [
  'blackCard.marketing.step2Item1',
  'blackCard.marketing.step2Item2',
  'blackCard.marketing.step2Item3',
  'blackCard.marketing.step2Item4',
];

const stepThreeItemKeys: TranslationKey[] = [
  'blackCard.marketing.step3Item1',
  'blackCard.marketing.step3Item2',
  'blackCard.marketing.step3Item3',
];

const disclaimerKeys: TranslationKey[] = [
  'blackCard.marketing.disclaimerLine1',
  'blackCard.marketing.disclaimerLine2',
  'blackCard.marketing.disclaimerLine3',
];

export default function BlackCardScreen({navigation}: Props) {
  const {t} = useLanguage();
  if (!branding.blackCard.enabled) {
    return (
      <AppScreen contentStyle={styles.screen} contentWidth="dashboard">
        <ActionHeader title={t('blackCard.marketing.pageTitle')} onBack={navigation.goBack} />
        <Text style={styles.informationNoticeText}>{t('blackCard.marketing.informationOnlyNotice')}</Text>
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.screen} contentWidth="dashboard">
      <ActionHeader
        title={t('blackCard.marketing.pageTitle')}
        subtitle={t('blackCard.marketing.pageSubtitle')}
        onBack={navigation.goBack}
      />

      <ImageBackground
        accessible={false}
        imageStyle={styles.heroBackgroundImage}
        resizeMode="cover"
        source={BLACK_CARD_BACKGROUND}
        style={styles.hero}
      >
        <View pointerEvents="none" style={styles.heroOverlay} />
        <Text style={styles.heroEyebrow}>{branding.displayName}</Text>
        <Text accessibilityRole="header" style={styles.heroTitle}>
          {t('blackCard.marketing.heroTitle')}
        </Text>
        <Text style={styles.heroSubtitle}>
          {t('blackCard.marketing.heroSubtitle')}
        </Text>
        <Image
          accessibilityLabel={t('blackCard.marketing.cardImageA11y')}
          accessibilityRole="image"
          resizeMode="contain"
          source={BLACK_CARD_IMAGE}
          style={styles.cardImage}
        />
      </ImageBackground>

      <View style={styles.informationNotice}>
        <ShieldCheck color={colors.gold} size={20} strokeWidth={2.2} />
        <Text style={styles.informationNoticeText}>
          {t('blackCard.marketing.informationOnlyNotice')}
        </Text>
      </View>

      <SectionHeading title={t('blackCard.marketing.featuresTitle')} />
      <View style={styles.featureList}>
        {featureItems.map(({Icon, titleKey, descriptionKey}) => (
          <ActionCard key={titleKey} style={styles.featureCard}>
            <View style={styles.featureIcon}>
              <Icon color={colors.gold} size={20} strokeWidth={2.1} />
            </View>
            <View style={styles.featureText}>
              <Text style={styles.featureTitle}>{t(titleKey)}</Text>
              <Text selectable style={styles.featureDescription}>
                {t(descriptionKey)}
              </Text>
            </View>
          </ActionCard>
        ))}
      </View>

      <View style={styles.ctaCard}>
        <View style={styles.ctaIcon}>
          <CreditCard color={colors.black} size={23} strokeWidth={2.2} />
        </View>
        <View style={styles.ctaText}>
          <Text accessibilityRole="header" style={styles.ctaTitle}>
            {t('blackCard.marketing.ctaTitle')}
          </Text>
          <Text style={styles.ctaDescription}>
            {t('blackCard.marketing.ctaLine1')}
          </Text>
          <Text style={styles.ctaDescription}>
            {t('blackCard.marketing.ctaLine2')}
          </Text>
        </View>
      </View>

      <SectionHeading title={t('blackCard.marketing.stepsTitle')} />
      <View style={styles.steps}>
        <StepCard
          description={t('blackCard.marketing.step1Desc')}
          number="1"
          title={t('blackCard.marketing.step1Title')}
        />
        <StepCard
          description={t('blackCard.marketing.step2Desc')}
          footer={t('blackCard.marketing.step2Footer')}
          items={stepTwoItemKeys.map(key =>
            t(key, {email: CARD_SUPPORT_EMAIL}),
          )}
          number="2"
          subtitle={t('blackCard.marketing.step2Subtitle')}
          title={t('blackCard.marketing.step2Title')}
        />
        <StepCard
          description={t('blackCard.marketing.step3Desc')}
          footer={t('blackCard.marketing.step3Footer')}
          items={stepThreeItemKeys.map(key => t(key))}
          number="3"
          title={t('blackCard.marketing.step3Title')}
        />
      </View>

      <ActionCard style={styles.helpCard}>
        <View style={styles.helpIcon}>
          <Mail color={colors.gold} size={21} strokeWidth={2.1} />
        </View>
        <View style={styles.helpText}>
          <Text accessibilityRole="header" style={styles.helpTitle}>
            {t('blackCard.marketing.helpTitle')}
          </Text>
          <Text style={styles.helpDescription}>
            {t('blackCard.marketing.helpDesc')}
          </Text>
          <Text
            accessibilityLabel={`${t(
              'blackCard.marketing.helpEmailLabel',
            )}${t('common.a11ySeparator')}${CARD_SUPPORT_EMAIL}`}
            selectable
            style={styles.helpEmail}
          >
            {CARD_SUPPORT_EMAIL}
          </Text>
        </View>
      </ActionCard>

      <View style={styles.disclaimerCard}>
        <Text accessibilityRole="header" style={styles.disclaimerTitle}>
          {t('blackCard.marketing.disclaimerTitle')}
        </Text>
        {disclaimerKeys.map((key, index) => (
          <View key={key} style={styles.disclaimerRow}>
            <Text style={styles.disclaimerNumber}>{index + 1}</Text>
            <Text selectable style={styles.disclaimerText}>
              {t(key)}
            </Text>
          </View>
        ))}
      </View>
    </AppScreen>
  );
}

function SectionHeading({title}: {title: string}) {
  return (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionLine} />
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
    </View>
  );
}

function StepCard({
  number,
  title,
  description,
  subtitle,
  items = [],
  footer,
}: {
  number: string;
  title: string;
  description: string;
  subtitle?: string;
  items?: string[];
  footer?: string;
}) {
  return (
    <ActionCard style={styles.stepCard}>
      <View style={styles.stepHeader}>
        <View style={styles.stepNumberWrap}>
          <Text style={styles.stepNumber}>{number}</Text>
        </View>
        <Text accessibilityRole="header" style={styles.stepTitle}>
          {title}
        </Text>
      </View>
      <Text selectable style={styles.stepDescription}>
        {description}
      </Text>
      {subtitle ? <Text style={styles.stepSubtitle}>{subtitle}</Text> : null}
      {items.length > 0 ? (
        <View style={styles.bulletList}>
          {items.map((item, index) => (
            <View key={`${number}-${index}`} style={styles.bulletRow}>
              <View style={styles.bullet} />
              <Text selectable style={styles.bulletText}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {footer ? (
        <View style={styles.stepFooter}>
          <Text selectable style={styles.stepFooterText}>
            {footer}
          </Text>
        </View>
      ) : null}
    </ActionCard>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingBottom: 40,
  },
  hero: {
    minHeight: 430,
    marginTop: 12,
    overflow: 'hidden',
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.34)',
    paddingHorizontal: 20,
    paddingTop: 34,
    paddingBottom: 24,
  },
  heroBackgroundImage: {
    borderRadius: 22,
  },
  heroOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(3,7,13,0.64)',
  },
  heroEyebrow: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 10,
    letterSpacing: 2,
  },
  heroTitle: {
    ...typography.bold,
    marginTop: 13,
    color: colors.white,
    fontSize: 27,
    textAlign: 'center',
  },
  heroSubtitle: {
    marginTop: 10,
    maxWidth: 480,
    color: 'rgba(244,247,248,0.78)',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  cardImage: {
    width: '94%',
    maxWidth: 520,
    aspectRatio: 1.707,
    marginTop: 28,
  },
  informationNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    marginTop: 12,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.26)',
    backgroundColor: colors.goldSoft,
    padding: 14,
  },
  informationNoticeText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 28,
    marginBottom: 12,
  },
  sectionLine: {
    width: 4,
    height: 21,
    borderRadius: 2,
    backgroundColor: colors.gold,
  },
  sectionTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 19,
  },
  featureList: {
    gap: 10,
  },
  featureCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  featureIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.20)',
    backgroundColor: colors.goldSoft,
  },
  featureText: {
    flex: 1,
    marginLeft: 13,
  },
  featureTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  featureDescription: {
    marginTop: 6,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  ctaCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 13,
    marginTop: 24,
    borderRadius: 17,
    backgroundColor: colors.gold,
    padding: 17,
  },
  ctaIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.52)',
  },
  ctaText: {
    flex: 1,
  },
  ctaTitle: {
    ...typography.bold,
    color: colors.black,
    fontSize: 16,
  },
  ctaDescription: {
    marginTop: 5,
    color: 'rgba(0,0,0,0.72)',
    fontSize: 11,
    lineHeight: 17,
  },
  steps: {
    gap: 12,
  },
  stepCard: {
    padding: 16,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  stepNumberWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.gold,
  },
  stepNumber: {
    ...typography.bold,
    color: colors.black,
    fontSize: 14,
  },
  stepTitle: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  stepDescription: {
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  stepSubtitle: {
    ...typography.bold,
    marginTop: 12,
    color: colors.text,
    fontSize: 11,
  },
  bulletList: {
    gap: 8,
    marginTop: 10,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  bullet: {
    width: 5,
    height: 5,
    marginTop: 7,
    borderRadius: 3,
    backgroundColor: colors.gold,
  },
  bulletText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  stepFooter: {
    marginTop: 13,
    borderRadius: 9,
    backgroundColor: colors.bgElevated,
    padding: 11,
  },
  stepFooterText: {
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 17,
  },
  helpCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 24,
  },
  helpIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: colors.goldSoft,
  },
  helpText: {
    flex: 1,
    marginLeft: 13,
  },
  helpTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
  },
  helpDescription: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  helpEmail: {
    ...typography.bold,
    marginTop: 9,
    color: colors.gold,
    fontSize: 13,
  },
  disclaimerCard: {
    gap: 12,
    marginTop: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bgElevated,
    padding: 15,
  },
  disclaimerTitle: {
    ...typography.bold,
    color: colors.warning,
    fontSize: 14,
  },
  disclaimerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  disclaimerNumber: {
    ...typography.bold,
    width: 18,
    color: colors.goldMuted,
    fontSize: 10,
  },
  disclaimerText: {
    flex: 1,
    color: colors.textSubtle,
    fontSize: 10,
    lineHeight: 17,
  },
});
