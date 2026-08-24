import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  BadgeCheck,
  BellRing,
  CreditCard,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react-native';
import {
  ActionCard,
  ActionHeader,
  InlineNotice,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import { useLanguage, type TranslationKey } from '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'BlackCard'>;

const informationItems: Array<{
  Icon: LucideIcon;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    Icon: BadgeCheck,
    titleKey: 'blackCard.benefitsTitle',
    descriptionKey: 'blackCard.benefitsDescription',
  },
  {
    Icon: BellRing,
    titleKey: 'blackCard.applicationTitle',
    descriptionKey: 'blackCard.applicationDescription',
  },
  {
    Icon: ShieldCheck,
    titleKey: 'blackCard.assetTitle',
    descriptionKey: 'blackCard.assetDescription',
  },
];

export default function BlackCardScreen({ navigation }: Props) {
  const { t } = useLanguage();

  return (
    <AppScreen contentStyle={styles.screen}>
      <ActionHeader
        title={t('blackCard.title')}
        subtitle={t('blackCard.subtitle')}
        onBack={navigation.goBack}
      />

      <View style={styles.hero}>
        <View style={styles.iconWrap}>
          <CreditCard color={colors.gold} size={30} strokeWidth={2} />
        </View>
        <Text style={styles.heroTitle}>{t('blackCard.heroTitle')}</Text>
        <Text style={styles.heroDescription}>
          {t('blackCard.heroDescription')}
        </Text>
      </View>

      <ActionCard style={styles.statusCard}>
        <Text style={styles.statusEyebrow}>{t('blackCard.statusEyebrow')}</Text>
        <Text style={styles.statusTitle}>{t('blackCard.statusTitle')}</Text>
        <Text style={styles.statusDescription}>
          {t('blackCard.statusDescription')}
        </Text>
      </ActionCard>

      <View style={styles.items}>
        {informationItems.map(({ Icon, titleKey, descriptionKey }) => (
          <ActionCard key={titleKey} style={styles.itemCard}>
            <View style={styles.itemIcon}>
              <Icon color={colors.gold} size={19} strokeWidth={2.2} />
            </View>
            <View style={styles.itemText}>
              <Text style={styles.itemTitle}>{t(titleKey)}</Text>
              <Text style={styles.itemDescription}>{t(descriptionKey)}</Text>
            </View>
          </ActionCard>
        ))}
      </View>

      <InlineNotice>{t('blackCard.notice')}</InlineNotice>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingBottom: 32,
  },
  hero: {
    marginTop: 12,
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.32)',
    backgroundColor: colors.card,
    paddingHorizontal: 22,
    paddingVertical: 26,
  },
  iconWrap: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.goldSoft,
  },
  heroTitle: {
    ...typography.bold,
    marginTop: 16,
    color: colors.text,
    fontSize: 22,
    textAlign: 'center',
  },
  heroDescription: {
    marginTop: 9,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
  },
  statusCard: {
    marginTop: 12,
  },
  statusEyebrow: {
    ...typography.bold,
    color: colors.gold,
    fontSize: 9,
    letterSpacing: 0.8,
  },
  statusTitle: {
    ...typography.bold,
    marginTop: 7,
    color: colors.text,
    fontSize: 16,
  },
  statusDescription: {
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 18,
  },
  items: {
    marginTop: 12,
    gap: 10,
  },
  itemCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  itemIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.goldSoft,
  },
  itemText: {
    flex: 1,
    marginLeft: 12,
  },
  itemTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  itemDescription: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 16,
  },
});
