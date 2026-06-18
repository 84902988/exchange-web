import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors} from '../../theme';

const links = ['保障与服务', '帮助中心', '公告入口'];

export default function ServiceLinks() {
  return (
    <View style={styles.row}>
      {links.map(item => (
        <Pressable key={item} style={styles.link}>
          <Text style={styles.mark}>{item.slice(0, 1)}</Text>
          <Text style={styles.label}>{item}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  link: {
    flex: 1,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  mark: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: '900',
  },
  label: {
    marginTop: 8,
    color: colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
});
