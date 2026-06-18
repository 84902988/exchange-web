import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {colors} from '../../theme';

type Props = {
  label: string;
  onPress?: () => void;
  badge?: boolean;
};

export default function IconButton({label, onPress, badge}: Props) {
  return (
    <Pressable style={styles.button} onPress={onPress}>
      <Text style={styles.label}>{label}</Text>
      {badge ? <Text style={styles.badge}> </Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  label: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  badge: {
    position: 'absolute',
    top: 7,
    right: 8,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.red,
    overflow: 'hidden',
  },
});
