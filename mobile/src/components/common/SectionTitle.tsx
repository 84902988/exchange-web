import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors} from '../../theme';

type Props = {
  title: string;
  action?: string;
};

export default function SectionTitle({title, action}: Props) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {action ? <Text style={styles.action}>{action}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '800',
  },
  action: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
});
