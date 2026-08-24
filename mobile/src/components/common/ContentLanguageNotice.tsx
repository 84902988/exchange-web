import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {
  getLocaleNativeName,
  normalizeMobileLocale,
  useLanguage,
} from '../../i18n';
import {colors, typography} from '../../theme';

type Props = {
  responseLocale?: string | null;
};

export default function ContentLanguageNotice({responseLocale}: Props) {
  const {locale, t} = useLanguage();
  const rawLocale = responseLocale?.trim();
  if (!rawLocale || !/^(?:zh|en|ja)(?:[-_]|$)/i.test(rawLocale)) return null;

  const actualLocale = normalizeMobileLocale(rawLocale);
  if (actualLocale === locale) return null;

  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.text}>
        {t('common.languageFallback', {
          language: getLocaleNativeName(actualLocale),
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    marginTop: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(243,179,74,0.32)',
    backgroundColor: 'rgba(243,179,74,0.10)',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  text: {
    ...typography.regular,
    color: colors.warning,
    fontSize: 11,
    lineHeight: 17,
  },
});
