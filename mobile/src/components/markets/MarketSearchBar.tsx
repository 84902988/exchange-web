import React from 'react';
import {StyleSheet, TextInput, View} from 'react-native';
import {Search} from 'lucide-react-native';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';

type Props = {
  value: string;
  onChangeText: (value: string) => void;
};

export default function MarketSearchBar({value, onChangeText}: Props) {
  const {t} = useLanguage();
  return (
    <View style={styles.container}>
      <View style={styles.inputWrap}>
        <Search color={colors.marketMuted} size={16} strokeWidth={2.1} />
        <TextInput
          accessibilityLabel={t('markets.searchA11y')}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={t('markets.searchPlaceholder')}
          placeholderTextColor={colors.marketSubtle}
          returnKeyType="search"
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inputWrap: {
    flex: 1,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    backgroundColor: colors.marketCard,
    borderWidth: 1,
    borderColor: colors.marketLine,
    paddingHorizontal: 12,
  },
  input: {
    ...typography.medium,
    flex: 1,
    color: colors.marketText,
    fontSize: 13,
    padding: 0,
  },
});
