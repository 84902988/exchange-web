import React from 'react';
import {Pressable, StyleSheet, TextInput, View} from 'react-native';
import {MoreHorizontal, Search} from 'lucide-react-native';
import {colors, typography} from '../../theme';

type Props = {
  value: string;
  onChangeText: (value: string) => void;
};

export default function MarketSearchBar({value, onChangeText}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.inputWrap}>
        <Search color={colors.marketMuted} size={16} strokeWidth={2.1} />
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="搜索"
          placeholderTextColor={colors.marketSubtle}
          returnKeyType="search"
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
        />
      </View>
      <Pressable
        accessibilityLabel="更多行情操作"
        accessibilityRole="button"
        hitSlop={8}
        style={styles.more}>
        <MoreHorizontal color={colors.marketText} size={22} strokeWidth={2.2} />
      </Pressable>
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
    height: 40,
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
  more: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.marketCard,
    borderWidth: 1,
    borderColor: colors.marketLine,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
