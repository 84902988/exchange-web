import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors} from '../../theme';

const entries = ['邀请中心', '代理好友', '理财活动', '账单', 'IPO Prime'];

export default function QuickEntryRow() {
  return (
    <View style={styles.row}>
      {entries.map(item => (
        <Pressable key={item} style={styles.item}>
          <View style={styles.icon}>
            <Text style={styles.iconText}>{item.slice(0, 1)}</Text>
          </View>
          <Text style={styles.label} numberOfLines={1}>
            {item}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  item: {
    width: '19%',
    alignItems: 'center',
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  iconText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '900',
  },
  label: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
});
