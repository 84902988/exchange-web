import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Check, Languages } from 'lucide-react-native';
import { ActionHeader } from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import { supportedLocales, useLanguage, type MobileLocale } from '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import { colors, typography } from '../../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'LanguageSettings'>;

export default function LanguageSettingsScreen({ navigation }: Props) {
  const { locale, setLocale, t } = useLanguage();

  return (
    <AppScreen contentStyle={styles.screen}>
      <ActionHeader
        backAccessibilityLabel={t('common.back')}
        onBack={navigation.goBack}
        subtitle={t('language.subtitle')}
        title={t('language.title')}
      />

      <View style={styles.introCard}>
        <View style={styles.introIcon}>
          <Languages color={colors.gold} size={24} strokeWidth={2.1} />
        </View>
        <View style={styles.introCopy}>
          <Text style={styles.introTitle}>{t('language.select')}</Text>
          <Text style={styles.introDescription}>
            {t('language.interfaceDescription')}
          </Text>
        </View>
      </View>

      <View style={styles.options}>
        {supportedLocales.map(option => (
          <LanguageOption
            active={option.locale === locale}
            key={option.locale}
            locale={option.locale}
            name={option.nativeName}
            onPress={() => setLocale(option.locale).catch(() => {})}
            selectedLabel={t('language.active')}
          />
        ))}
      </View>

      <View style={styles.noteCard}>
        <Text style={styles.noteTitle}>{t('language.contentTitle')}</Text>
        <Text style={styles.noteDescription}>
          {t('language.contentDescription')}
        </Text>
      </View>
    </AppScreen>
  );
}

function LanguageOption({
  active,
  locale,
  name,
  onPress,
  selectedLabel,
}: {
  active: boolean;
  locale: MobileLocale;
  name: string;
  onPress: () => void;
  selectedLabel: string;
}) {
  return (
    <Pressable
      accessibilityLabel={active ? `${name}, ${selectedLabel}` : name}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        active ? styles.optionActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.optionCopy}>
        <Text style={styles.optionName}>{name}</Text>
        <Text style={styles.optionCode}>{locale}</Text>
      </View>
      {active ? (
        <View style={styles.check}>
          <Check color={colors.black} size={17} strokeWidth={2.8} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  screen: {
    paddingBottom: 32,
  },
  introCard: {
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(214,168,50,0.24)',
    backgroundColor: colors.card,
    padding: 15,
  },
  introIcon: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
    backgroundColor: colors.goldSoft,
  },
  introCopy: {
    flex: 1,
  },
  introTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 16,
  },
  introDescription: {
    ...typography.regular,
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  options: {
    marginTop: 16,
    overflow: 'hidden',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  option: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  optionActive: {
    backgroundColor: 'rgba(214,168,50,0.09)',
  },
  optionCopy: {
    flex: 1,
  },
  optionName: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 15,
  },
  optionCode: {
    ...typography.caption,
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 11,
  },
  check: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: colors.gold,
  },
  noteCard: {
    marginTop: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 15,
  },
  noteTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
  },
  noteDescription: {
    ...typography.regular,
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 19,
  },
});
