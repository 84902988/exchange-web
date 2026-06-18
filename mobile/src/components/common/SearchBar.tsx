import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors} from '../../theme';

type Props = {
  placeholder?: string;
};

export default function SearchBar({placeholder = '搜索 UNI'}: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.searchMark}>S</Text>
      <Text style={styles.placeholder}>{placeholder}</Text>
    </View>
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
  },
  searchMark: {
    color: colors.textSubtle,
    fontSize: 12,
    fontWeight: '900',
    marginRight: 8,
  },
  placeholder: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
