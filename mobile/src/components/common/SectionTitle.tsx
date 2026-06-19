import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';

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
    ...typography.sectionTitle,
    color: colors.text,
  },
  action: {
    ...typography.action,
    color: colors.textMuted,
  },
});
