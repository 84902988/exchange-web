import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Search } from 'lucide-react-native';
import { useLanguage } from '../../i18n';
import { colors, typography } from '../../theme';

type Props = {
  placeholder?: string;
  onPress?: () => void;
};

export default function SearchBar({ placeholder, onPress }: Props) {
  const { t } = useLanguage();
  const resolvedPlaceholder = placeholder ?? t('home.searchMarket');
  return (
    <Pressable
      accessibilityLabel={resolvedPlaceholder}
      accessibilityRole={onPress ? 'button' : undefined}
      android_ripple={
        onPress ? { color: 'rgba(212, 175, 55, 0.1)' } : undefined
      }
      style={({ pressed }) => [
        styles.container,
        pressed && onPress ? styles.pressed : null,
      ]}
      onPress={onPress}
    >
      <Search color={colors.textSubtle} size={17} strokeWidth={2.1} />
      <Text style={styles.placeholder}>{resolvedPlaceholder}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.995 }] },
  container: {
    flex: 1,
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 8,
  },
  placeholder: {
    ...typography.regular,
    color: colors.textMuted,
    fontSize: 13,
  },
});
