import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {Search} from 'lucide-react-native';
import {colors} from '../../theme';

type Props = {
  placeholder?: string;
  onPress?: () => void;
};

export default function SearchBar({placeholder = '搜索 UNI', onPress}: Props) {
  return (
    <Pressable
      accessibilityLabel={placeholder}
      accessibilityRole={onPress ? 'button' : undefined}
      style={styles.container}
      onPress={onPress}>
      <Search color={colors.textSubtle} size={17} strokeWidth={2.1} />
      <Text style={styles.placeholder}>{placeholder}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 19,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 8,
  },
  placeholder: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
